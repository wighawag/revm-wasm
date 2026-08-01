//! The engine half of `revm-wasm`: a `revm::Database` backed by a narrow
//! synchronous host interface, a precompile provider whose set cannot be
//! rebuilt out from under it, and the binary outcome encoding.
//!
//! This crate is deliberately host-agnostic. The wasm32 cdylib in `../wasm`
//! implements [`HostDb`] over imported functions; a native binary can implement
//! it over in-memory maps and get the *identical* execution path, which is what
//! makes a native-against-wasm differential a real comparison rather than a
//! comparison of two different programs.
//!
//! Nothing about the Ethereum semantics is implemented here. Fee arithmetic,
//! EIP-161 state clearing, EIP-6780, access-list warming, intrinsic gas and
//! refunds are all driven out of revm's own `pre_execution`, `post_execution`
//! and `validation` paths. Where a rule appears in this file it is transcribed
//! from a named revm source location and says so.

use revm::{
    context::{
        either::Either,
        result::{ExecutionResult, Output},
        BlockEnv, CfgEnv, Context, Evm, Journal, TxEnv,
    },
    context_interface::{
        transaction::{
            AccessList, AccessListItem, Authorization, RecoveredAuthorization, SignedAuthorization,
        },
        Cfg, ContextTr, Transaction,
    },
    database_interface::{DBErrorMarker, DatabaseCommit},
    handler::EthFrame,
    handler::{instructions::EthInstructions, EthPrecompiles, MainContext, PrecompileProvider},
    interpreter::interpreter::EthInterpreter,
    interpreter::{CallInputs, InterpreterResult},
    precompile::Precompiles,
    primitives::{
        alloy_primitives::Bloom, hardfork::SpecId, Address, AddressMap, AddressSet, StorageKey,
        StorageValue, TxKind, B256, KECCAK_EMPTY, U256,
    },
    state::{Account, AccountInfo, Bytecode},
    Database, ExecuteEvm,
};

pub use revm;

/// Per-request behaviour switches. Deliberately explicit: an `eth_call` must
/// never commit, a transaction always must, and the caller decides which it is.
///
/// **Bits 7 and above are unallocated and reserved.** That is a forward
/// compatibility guarantee, not an accident: a future per-call capability (a
/// trace, a size-variant switch, a custom-precompile opt-in) can be enabled by
/// setting a new bit, without adding an argument and without a breaking change
/// to any entry point. An unknown bit is currently ignored rather than
/// rejected, so an older artifact paired with a newer caller degrades to "the
/// capability did not happen" instead of trapping.
pub mod flags {
    /// Commit the resulting state to the host database (see [`crate::HostDatabase`]'s
    /// `DatabaseCommit` impl). Absent this bit the call is pure read-only.
    pub const COMMIT: u32 = 1 << 0;
    /// The transaction is a contract creation: `to` is ignored and `data` is the
    /// init code.
    pub const CREATE: u32 = 1 << 1;
    /// All three simulation switches at once, i.e. exactly
    /// `DISABLE_BASE_FEE | DISABLE_BALANCE_CHECK | DISABLE_BLOCK_GAS_LIMIT`.
    ///
    /// This bit predates them: it was the light path's single all-or-nothing
    /// relaxation, back when the relaxation was a measurement rather than a
    /// capability. It keeps its meaning (a superset shortcut) rather than being
    /// reused for something else, per ADR 0004, and now applies on both paths.
    /// New callers should set the individual bits, because an `eth_call` that
    /// skips the base fee usually still wants the block gas limit enforced.
    pub const RELAX_VALIDATION: u32 = 1 << 2;
    /// Enforce the transaction nonce against the sender's account nonce.
    ///
    /// Off by default because every call in parts 1 and 2 ran with
    /// `disable_nonce_check = true` (`eth_call` semantics), and turning it on
    /// unconditionally would move results for the whole existing corpus. A real
    /// transaction should set it; an `eth_call` should not.
    pub const CHECK_NONCE: u32 = 1 << 3;

    // -- simulation switches ------------------------------------------------
    //
    // revm's own `CfgEnv` fields, which is what upstream clients set to serve
    // `eth_call`. Each is OFF unless the bit is set, so the default behaviour of
    // every entry point is unchanged, and each requires the `relaxed-validation`
    // cargo feature (which the shipped build DOES enable; see Cargo.toml).
    // Without it the corresponding `CfgEnv` field does not exist and the bit is
    // ignored, which fails loudly as a rejected transaction rather than quietly
    // as a wrong number.

    /// Skip the `gasPrice >= block base fee` check (revm `disable_base_fee`),
    /// so a zero-gas-price simulation can run against a block that carries a
    /// real, non-zero base fee and still see that base fee from `BASEFEE`.
    ///
    /// It suppresses the *check* only. The fee arithmetic is untouched, so the
    /// effective gas price and the caller's charge are still revm's own.
    pub const DISABLE_BASE_FEE: u32 = 1 << 4;
    /// Skip the `balance >= gasLimit * gasPrice + value` check (revm
    /// `disable_balance_check`), so a simulation from an address that holds no
    /// ether is possible.
    ///
    /// **This one fabricates state**: revm's `calculate_caller_fee` raises the
    /// caller's post-deduction balance to at least `tx.value()`, so the caller's
    /// balance in the returned state map can be a number the chain never had.
    /// That is fine for a discarded read and is why the TypeScript layer refuses
    /// to combine it with a commit.
    pub const DISABLE_BALANCE_CHECK: u32 = 1 << 5;
    /// Skip the `tx gasLimit <= block gasLimit` check (revm
    /// `disable_block_gas_limit`), which an `eth_estimateGas` binary search
    /// starting above the block's own limit would otherwise trip.
    pub const DISABLE_BLOCK_GAS_LIMIT: u32 = 1 << 6;
}

/// The transaction-level validations a simulation may switch off, resolved from
/// a request's [`flags`].
///
/// A struct rather than three booleans threaded by hand, because the full path
/// and the light path must resolve them identically: the executor is persistent,
/// so a switch left set from a previous call is a silent cross-call leak.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ValidationSwitches {
    pub base_fee: bool,
    pub balance: bool,
    pub block_gas_limit: bool,
}

impl ValidationSwitches {
    /// Resolve from a flag word. [`flags::RELAX_VALIDATION`] sets all three.
    #[inline]
    pub fn from_flags(f: u32) -> Self {
        let all = f & flags::RELAX_VALIDATION != 0;
        Self {
            base_fee: all || f & flags::DISABLE_BASE_FEE != 0,
            balance: all || f & flags::DISABLE_BALANCE_CHECK != 0,
            block_gas_limit: all || f & flags::DISABLE_BLOCK_GAS_LIMIT != 0,
        }
    }
}

/// Narrow, synchronous host interface. Every method writes its result into a
/// caller-provided buffer; nothing is allocated or serialised per access.
///
/// The wasm implementation maps each of these 1:1 onto an imported JS function,
/// so the number of wasm->JS boundary crossings per state access is exactly one.
pub trait HostDb {
    /// Account basics. `out` layout: `[0..32] balance (big-endian)`,
    /// `[32..40] nonce (little-endian u64)`, `[40..72] code hash`.
    /// Returns `false` if the account does not exist.
    fn basic(&mut self, address: &[u8; 20], out: &mut [u8; 72]) -> bool;

    /// Storage slot value, big-endian, written into `out`.
    fn storage(&mut self, address: &[u8; 20], key: &[u8; 32], out: &mut [u8; 32]);

    /// Length in bytes of the code with this hash. Split from `code_copy` so the
    /// wasm side can allocate exactly once and let the host memcpy straight into
    /// linear memory.
    fn code_len(&mut self, code_hash: &[u8; 32]) -> usize;

    /// Copy the code with this hash into `out` (which is exactly `code_len` long).
    fn code_copy(&mut self, code_hash: &[u8; 32], out: &mut [u8]);

    /// Block hash for a block number, written into `out`.
    fn block_hash(&mut self, number: u64, out: &mut [u8; 32]);

    // -- write side -----------------------------------------------------
    //
    // Only reached from [`HostDatabase`]'s `DatabaseCommit` impl, i.e. only when a
    // request sets `flags::COMMIT`. A read-only host may leave these `todo!()`
    // as long as it never asks for a commit.

    /// Insert or overwrite an account. `packed` uses the same 72-byte layout as
    /// [`HostDb::basic`].
    fn set_account(&mut self, address: &[u8; 20], packed: &[u8; 72]);

    /// Store code under its hash, so a later [`HostDb::code_len`] can find it.
    fn set_code(&mut self, code_hash: &[u8; 32], code: &[u8]);

    /// Write one storage slot.
    fn set_storage(&mut self, address: &[u8; 20], key: &[u8; 32], value: &[u8; 32]);

    /// Drop every storage slot of an account. Used for `SELFDESTRUCT` and for a
    /// freshly created account, whose storage must start empty even if the
    /// address was previously used.
    fn clear_storage(&mut self, address: &[u8; 20]);

    /// Remove the account entirely, so a later [`HostDb::basic`] reports it as
    /// non-existent. Used for `SELFDESTRUCT` and EIP-161 empty-account deletion.
    fn remove_account(&mut self, address: &[u8; 20]);
}

/// Lets a caller reuse one host across many calls without cloning it. Nothing in
/// `execute_call` mutates host state (there is no `DatabaseCommit`), so the same
/// host can serve an entire fixture.
impl<T: HostDb> HostDb for &mut T {
    #[inline]
    fn basic(&mut self, address: &[u8; 20], out: &mut [u8; 72]) -> bool {
        (**self).basic(address, out)
    }
    #[inline]
    fn storage(&mut self, address: &[u8; 20], key: &[u8; 32], out: &mut [u8; 32]) {
        (**self).storage(address, key, out)
    }
    #[inline]
    fn code_len(&mut self, code_hash: &[u8; 32]) -> usize {
        (**self).code_len(code_hash)
    }
    #[inline]
    fn code_copy(&mut self, code_hash: &[u8; 32], out: &mut [u8]) {
        (**self).code_copy(code_hash, out)
    }
    #[inline]
    fn block_hash(&mut self, number: u64, out: &mut [u8; 32]) {
        (**self).block_hash(number, out)
    }
    #[inline]
    fn set_account(&mut self, address: &[u8; 20], packed: &[u8; 72]) {
        (**self).set_account(address, packed)
    }
    #[inline]
    fn set_code(&mut self, code_hash: &[u8; 32], code: &[u8]) {
        (**self).set_code(code_hash, code)
    }
    #[inline]
    fn set_storage(&mut self, address: &[u8; 20], key: &[u8; 32], value: &[u8; 32]) {
        (**self).set_storage(address, key, value)
    }
    #[inline]
    fn clear_storage(&mut self, address: &[u8; 20]) {
        (**self).clear_storage(address)
    }
    #[inline]
    fn remove_account(&mut self, address: &[u8; 20]) {
        (**self).remove_account(address)
    }
}

/// Error type for [`HostDatabase`]. The host interface is infallible by construction:
/// a JS host that cannot answer a read must throw, which traps the wasm module.
/// Modelling it as infallible keeps `Result` handling out of the hot path.
#[derive(Debug)]
pub struct HostDbError;

impl core::fmt::Display for HostDbError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("revm-wasm host db error")
    }
}
impl core::error::Error for HostDbError {}
impl DBErrorMarker for HostDbError {}

/// `revm::Database` adapter over a [`HostDb`].
pub struct HostDatabase<H: HostDb> {
    pub host: H,
    /// Code hash each address had *before* this transaction touched it, recorded
    /// on first load. It is the only way to answer "did this account's code
    /// change?" at encode time: `AccountInfo::code` is populated by an ordinary
    /// `load_code` for any contract that merely *executed*, so its presence says
    /// nothing about whether the code is new.
    ///
    /// Only non-empty hashes are recorded, so a plain EOA read costs no insert;
    /// a missing entry means `KECCAK_EMPTY`, which is the right default for both
    /// non-existent and codeless accounts.
    pub original_code_hash: AddressMap<B256>,
}

impl<H: HostDb> HostDatabase<H> {
    pub fn new(host: H) -> Self {
        Self {
            host,
            original_code_hash: AddressMap::default(),
        }
    }

    /// Code hash the address had at the start of the current transaction.
    #[inline]
    pub fn original_code_hash_of(&self, address: &Address) -> B256 {
        self.original_code_hash
            .get(address)
            .copied()
            .unwrap_or(KECCAK_EMPTY)
    }

    /// Must be called before each transaction: after a commit the "original"
    /// hashes of the previous transaction are stale.
    #[inline]
    pub fn begin_tx(&mut self) {
        self.original_code_hash.clear();
    }
}

impl<H: HostDb> Database for HostDatabase<H> {
    type Error = HostDbError;

    fn basic(&mut self, address: Address) -> Result<Option<AccountInfo>, Self::Error> {
        let mut out = [0u8; 72];
        if !self.host.basic(&address.0 .0, &mut out) {
            return Ok(None);
        }
        let mut balance = [0u8; 32];
        balance.copy_from_slice(&out[0..32]);
        let mut nonce = [0u8; 8];
        nonce.copy_from_slice(&out[32..40]);
        let mut code_hash = [0u8; 32];
        code_hash.copy_from_slice(&out[40..72]);
        let code_hash = B256::from(code_hash);
        if code_hash != KECCAK_EMPTY {
            self.original_code_hash.insert(address, code_hash);
        }
        Ok(Some(AccountInfo {
            balance: U256::from_be_bytes(balance),
            nonce: u64::from_le_bytes(nonce),
            code_hash,
            account_id: None,
            // Deliberately `None`: revm will only call `code_by_hash` when the
            // code is actually needed, so a plain balance read never pays for a
            // code copy across the boundary.
            code: None,
        }))
    }

    fn code_by_hash(&mut self, code_hash: B256) -> Result<Bytecode, Self::Error> {
        let hash = code_hash.0;
        let len = self.host.code_len(&hash);
        if len == 0 {
            return Ok(Bytecode::default());
        }
        let mut buf = vec![0u8; len];
        self.host.code_copy(&hash, &mut buf);
        Ok(Bytecode::new_raw(buf.into()))
    }

    fn storage(
        &mut self,
        address: Address,
        index: StorageKey,
    ) -> Result<StorageValue, Self::Error> {
        let key = index.to_be_bytes::<32>();
        let mut out = [0u8; 32];
        self.host.storage(&address.0 .0, &key, &mut out);
        Ok(StorageValue::from_be_bytes(out))
    }

    fn block_hash(&mut self, number: u64) -> Result<B256, Self::Error> {
        let mut out = [0u8; 32];
        self.host.block_hash(number, &mut out);
        Ok(B256::from(out))
    }
}

/// Write the finished state back to the host.
///
/// The rules below are revm's own commit semantics, transcribed from
/// `CacheDB::commit_account` (`crates/database/src/in_memory_db.rs`) and
/// `Cache::apply_account_state` (`crates/database/src/states/cache.rs`). They
/// are not reinvented here, because getting them wrong is silent:
///
/// * **untouched** accounts are never written;
/// * **selfdestructed** accounts have their storage dropped and the account
///   removed, so a later `basic` reports "does not exist";
/// * **created** accounts replace whatever was there, and their storage starts
///   empty even if the address was used before (`clear_storage` first);
/// * **empty** touched accounts (nonce 0, balance 0, no code) are deleted, which
///   is EIP-161 state clearing. revm's `Journal::finalize` normalises the
///   pre-Spurious-Dragon case for us by clearing the touch flag, so this rule can
///   be applied unconditionally;
/// * everything else is an in-place update of info plus changed slots.
impl<H: HostDb> DatabaseCommit for HostDatabase<H> {
    fn commit(&mut self, changes: AddressMap<Account>) {
        // Sorted so a commit issues host writes in a deterministic order; the
        // resulting state is order-independent, but a deterministic trace is much
        // easier to diff when something does go wrong.
        let mut accounts: Vec<(Address, Account)> = changes.into_iter().collect();
        accounts.sort_by_key(|(addr, _)| *addr);
        for (address, account) in accounts {
            self.commit_account(address, account);
        }
    }
}

/// Does committing this account delete it?
///
/// True for a `SELFDESTRUCT`ed account and for a touched empty one (EIP-161
/// state clearing). Shared by the commit path and by [`encode_outcome`], so a
/// host that applies the blob itself and a host that lets the wasm commit can
/// never disagree about which accounts disappear.
#[inline]
pub fn account_is_deleted(account: &Account) -> bool {
    account.is_touched() && (account.is_selfdestructed() || account.info.is_empty())
}

impl<H: HostDb> HostDatabase<H> {
    fn commit_account(&mut self, address: Address, account: Account) {
        let addr = &address.0 .0;
        if !account.is_touched() {
            return;
        }
        if account_is_deleted(&account) {
            // Storage of a deleted account is unreachable, so drop it too rather
            // than leaving orphans behind in the host's maps.
            self.host.clear_storage(addr);
            self.host.remove_account(addr);
            return;
        }
        if account.is_created() {
            self.host.clear_storage(addr);
        }

        if let Some(code) = account.info.code.as_ref() {
            if account.info.code_hash != KECCAK_EMPTY && !code.is_empty() {
                self.host
                    .set_code(&account.info.code_hash.0, code.original_byte_slice());
            }
        }

        let mut packed = [0u8; 72];
        packed[0..32].copy_from_slice(&account.info.balance.to_be_bytes::<32>());
        packed[32..40].copy_from_slice(&account.info.nonce.to_le_bytes());
        packed[40..72].copy_from_slice(account.info.code_hash.as_slice());
        self.host.set_account(addr, &packed);

        for (key, slot) in account.storage.iter() {
            if !account.is_created() && !slot.is_changed() {
                continue;
            }
            self.host.set_storage(
                addr,
                &key.to_be_bytes::<32>(),
                &slot.present_value.to_be_bytes::<32>(),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Precompile set selection
// ---------------------------------------------------------------------------

/// Build the precompile set for this build configuration.
///
/// **The shipped build is `precompiles-all` and that is not negotiable.** See
/// `docs/adr/0001-all-precompiles-opt-level-3.md`: an omitted precompile
/// address stops being pre-warmed by `pre_execution::load_accounts`, so touching
/// it costs a cold access instead of a warm one, measured at +2,500 gas per
/// omitted address touched. A subset build is not smaller-and-equivalent, it is
/// a different EVM that disagrees with mainnet about gas.
///
/// The other two configurations exist only so that claim stays measurable. Note
/// that revm exposes *no* per-precompile cargo features: `revm-precompile`
/// depends on `k256`, `ark-bn254`, `ark-bls12-381`, `p256` and
/// `aurora-engine-modexp` unconditionally. The only lever is reachability, i.e.
/// whether a given `PrecompileFn` is ever referenced, so that LTO can drop it,
/// and even that only buys about 6% because `precompile::interface::crypto()`
/// materialises a `Box<dyn Crypto>` whose vtable pulls in every backend.
#[allow(unused_variables)]
fn precompiles_for(spec: SpecId) -> &'static Precompiles {
    #[cfg(feature = "precompiles-all")]
    {
        use revm::precompile::PrecompileSpecId;
        Precompiles::new(PrecompileSpecId::from_spec_id(spec))
    }
    #[cfg(feature = "precompiles-common")]
    {
        use revm::precompile::{bn254, hash, identity, modexp, secp256k1};
        use revm::primitives::OnceLock;
        static SET: OnceLock<Precompiles> = OnceLock::new();
        SET.get_or_init(|| {
            let mut p = Precompiles::default();
            p.extend([
                secp256k1::ECRECOVER,
                hash::SHA256,
                hash::RIPEMD160,
                identity::FUN,
                modexp::BERLIN,
                bn254::add::ISTANBUL,
                bn254::mul::ISTANBUL,
                bn254::pair::ISTANBUL,
            ]);
            p
        })
    }
    #[cfg(feature = "precompiles-none")]
    {
        use revm::primitives::OnceLock;
        static SET: OnceLock<Precompiles> = OnceLock::new();
        SET.get_or_init(Precompiles::default)
    }
}

/// A [`PrecompileProvider`] whose precompile set is fixed at construction.
///
/// This exists because [`EthPrecompiles`] cannot be subset. Its
/// `PrecompileProvider::set_spec` does
/// `self.precompiles = Precompiles::new(PrecompileSpecId::from_spec_id(spec))`,
/// and the handler calls `set_spec` on every transaction from
/// `handler::pre_execution::load_accounts`. So assigning a custom map to
/// `Evm::precompiles` is defeated twice over: the map is overwritten at runtime,
/// and the static reference to `Precompiles::new` keeps every crypto backend
/// alive through LTO.
///
/// `run` still delegates to the stock `EthPrecompiles` implementation, so gas
/// accounting and error mapping are unmodified revm.
#[derive(Debug)]
pub struct FixedPrecompiles {
    inner: EthPrecompiles,
}

impl FixedPrecompiles {
    pub fn new(precompiles: &'static Precompiles, spec: SpecId) -> Self {
        Self {
            inner: EthPrecompiles { precompiles, spec },
        }
    }
}

impl<CTX: ContextTr> PrecompileProvider<CTX> for FixedPrecompiles {
    type Output = InterpreterResult;

    fn set_spec(&mut self, spec: <CTX::Cfg as Cfg>::Spec) -> bool {
        let spec: SpecId = spec.into();
        let changed = spec != self.inner.spec;
        // Deliberately does NOT rebuild the map.
        self.inner.spec = spec;
        changed
    }

    fn run(
        &mut self,
        context: &mut CTX,
        inputs: &CallInputs,
    ) -> Result<Option<Self::Output>, String> {
        PrecompileProvider::<CTX>::run(&mut self.inner, context, inputs)
    }

    fn warm_addresses(&self) -> &AddressSet {
        self.inner.warm_addresses()
    }

    fn contains(&self, address: &Address) -> bool {
        self.inner.contains(address)
    }
}

// ---------------------------------------------------------------------------
// Call execution
// ---------------------------------------------------------------------------

/// Fee-market and typed-transaction fields.
///
/// **None of the arithmetic lives here.** These values are handed straight to
/// revm's `TxEnv` / `BlockEnv`, and revm's own `pre_execution::deduct_caller`,
/// `post_execution::reward_beneficiary` and `validation::validate_tx_env` do
/// the charging, the refunding and the rejections. Reimplementing
/// `min(maxFee, baseFee + tip)`, EIP-161, EIP-6780, access-list warming or
/// intrinsic gas on either side of this boundary is explicitly out of bounds.
///
/// The default is "no fee inputs at all": zero gas price, no priority fee, zero
/// base fee, empty lists. A request carrying no extras therefore takes exactly
/// the same path as a zero-fee call, which is what makes a zero-fee control
/// corpus meaningful as a non-regression check.
#[derive(Clone, Debug, Default)]
pub struct TxExtras {
    /// Legacy / EIP-2930 `gasPrice`, or EIP-1559 `maxFeePerGas`. revm keeps both
    /// in the single `TxEnv::gas_price` field and reads it through
    /// `Transaction::max_fee_per_gas`.
    pub gas_price: u128,
    /// EIP-1559 `maxPriorityFeePerGas`. `None` marks a pre-1559 transaction; the
    /// distinction matters because `TxEnv::derive_tx_type` keys off it.
    pub gas_priority_fee: Option<u128>,
    /// Explicit transaction type. `None` lets revm derive it from the fields,
    /// which is what an ordinary caller wants; the state-test converter sets it
    /// explicitly because the fixtures do.
    pub tx_type: Option<u8>,
    /// Transaction nonce. Only enforced when [`flags::CHECK_NONCE`] is set.
    pub nonce: u64,
    /// EIP-2930 access list. revm warms it in `pre_execution::load_accounts` and
    /// charges the intrinsic cost in `validate_initial_tx_gas`.
    pub access_list: AccessList,
    /// EIP-4844 blob versioned hashes.
    pub blob_hashes: Vec<B256>,
    /// EIP-4844 `maxFeePerBlobGas`.
    pub max_fee_per_blob_gas: u128,
    /// EIP-7702 authorization list.
    pub authorization_list: Vec<Either<SignedAuthorization, RecoveredAuthorization>>,
    /// Block base fee per gas (EIP-1559).
    pub basefee: u64,
    /// Block `excessBlobGas`. `None` means "this block has none", which resets
    /// it rather than leaving the previous call's value in place: the executor
    /// is persistent, so anything not assigned on every call is sticky.
    pub excess_blob_gas: Option<u64>,
    /// Block `prevRandao` (EIP-4399), what `PREVRANDAO` reads post-merge.
    /// `None` means zero, which is revm's own `BlockEnv` default.
    pub prev_randao: Option<B256>,
}

/// Version byte of the encoded extras blob. Bumped if the layout ever changes;
/// an unknown version is rejected rather than misread.
pub const TX_EXTRAS_VERSION: u8 = 1;

/// Fixed-size part of the encoded extras blob (see [`TxExtras::decode`]).
const TX_EXTRAS_HEAD: usize = 76;

fn read_u128_be(b: &[u8]) -> u128 {
    let mut a = [0u8; 16];
    a.copy_from_slice(b);
    u128::from_be_bytes(a)
}

fn read_u64_le(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(b);
    u64::from_le_bytes(a)
}

impl TxExtras {
    /// Decode the compact extras blob the host passes alongside a call.
    ///
    /// ```text
    /// u8    version (must be TX_EXTRAS_VERSION)
    /// u8    present: bit0 gas_priority_fee, bit1 tx_type, bit2 excess_blob_gas,
    ///               bit3 prev_randao (appended after the authorization list)
    /// u8    tx_type          (meaningful only if bit1)
    /// u8    reserved (0)
    /// [16]  gas_price / max_fee_per_gas, big-endian
    /// [16]  max_priority_fee_per_gas, big-endian
    /// [16]  max_fee_per_blob_gas, big-endian
    /// u64   basefee, little-endian
    /// u64   nonce, little-endian
    /// u64   excess_blob_gas, little-endian
    /// u32   access list entry count, then per entry:
    ///         [20] address, u32 storage key count, [32] * that many
    /// u32   blob hash count, then [32] * that many
    /// u32   authorization count, then per authorization:
    ///         [32] chain id big-endian, [20] address, u64 nonce little-endian,
    ///         u8 y_parity, [32] r big-endian, [32] s big-endian
    /// [32]  prev_randao, present only if bit3 of `present` is set
    /// ```
    ///
    /// `prev_randao` is APPENDED after the variable-length sections rather than
    /// placed in the fixed head, which is the same discipline the request and
    /// outcome blobs follow, and for the same reason: the head keeps its offsets
    /// and the version byte does not have to move. An older artifact reads the
    /// sections it knows, ignores an unknown `present` bit and stops at the end
    /// of the authorization list, so it degrades to "the capability did not
    /// happen" rather than misreading the blob.
    ///
    /// Everything is little-endian for the machine-word fields and big-endian
    /// for the 256-bit ones, matching the existing outcome blob so the harness
    /// needs no new conventions.
    pub fn decode(buf: &[u8]) -> Result<Self, String> {
        if !FEES_ENABLED || buf.is_empty() {
            return Ok(Self::default());
        }
        if buf.len() < TX_EXTRAS_HEAD {
            return Err(format!("TxExtrasTooShort({})", buf.len()));
        }
        if buf[0] != TX_EXTRAS_VERSION {
            return Err(format!("TxExtrasBadVersion({})", buf[0]));
        }
        let present = buf[1];
        let mut out = Self {
            gas_price: read_u128_be(&buf[4..20]),
            gas_priority_fee: (present & 1 != 0).then(|| read_u128_be(&buf[20..36])),
            tx_type: (present & 2 != 0).then_some(buf[2]),
            nonce: read_u64_le(&buf[60..68]),
            max_fee_per_blob_gas: read_u128_be(&buf[36..52]),
            basefee: read_u64_le(&buf[52..60]),
            excess_blob_gas: (present & 4 != 0).then(|| read_u64_le(&buf[68..76])),
            ..Default::default()
        };
        let has_prev_randao = present & 8 != 0;

        let mut o = TX_EXTRAS_HEAD;
        // -- access list --
        let need = |o: usize, n: usize, buf: &[u8]| -> Result<(), String> {
            if o + n > buf.len() {
                Err(format!("TxExtrasTruncated({o}+{n}>{})", buf.len()))
            } else {
                Ok(())
            }
        };
        need(o, 4, buf)?;
        let n_entries = read_u32_le(&buf[o..o + 4]) as usize;
        o += 4;
        let mut items = Vec::with_capacity(n_entries);
        for _ in 0..n_entries {
            need(o, 24, buf)?;
            let mut addr = [0u8; 20];
            addr.copy_from_slice(&buf[o..o + 20]);
            o += 20;
            let n_keys = read_u32_le(&buf[o..o + 4]) as usize;
            o += 4;
            need(o, n_keys * 32, buf)?;
            let mut keys = Vec::with_capacity(n_keys);
            for _ in 0..n_keys {
                keys.push(B256::from_slice(&buf[o..o + 32]));
                o += 32;
            }
            items.push(AccessListItem {
                address: Address::from(addr),
                storage_keys: keys,
            });
        }
        out.access_list = AccessList(items);

        // -- blob hashes --
        need(o, 4, buf)?;
        let n_blobs = read_u32_le(&buf[o..o + 4]) as usize;
        o += 4;
        need(o, n_blobs * 32, buf)?;
        out.blob_hashes = (0..n_blobs)
            .map(|i| B256::from_slice(&buf[o + i * 32..o + i * 32 + 32]))
            .collect();
        o += n_blobs * 32;

        // -- authorization list --
        need(o, 4, buf)?;
        let n_auth = read_u32_le(&buf[o..o + 4]) as usize;
        o += 4;
        let mut auths = Vec::with_capacity(n_auth);
        for _ in 0..n_auth {
            // 32 chain id + 20 address + 8 nonce + 1 y_parity + 32 r + 32 s
            need(o, 125, buf)?;
            let chain_id = U256::from_be_slice(&buf[o..o + 32]);
            let address = Address::from_slice(&buf[o + 32..o + 52]);
            let nonce = read_u64_le(&buf[o + 52..o + 60]);
            let y_parity = buf[o + 60];
            let r = U256::from_be_slice(&buf[o + 61..o + 93]);
            let s = U256::from_be_slice(&buf[o + 93..o + 125]);
            o += 125;
            auths.push(Either::Left(SignedAuthorization::new_unchecked(
                Authorization {
                    chain_id,
                    address,
                    nonce,
                },
                y_parity,
                r,
                s,
            )));
        }
        out.authorization_list = auths;

        // -- appended sections --
        if has_prev_randao {
            need(o, 32, buf)?;
            out.prev_randao = Some(B256::from_slice(&buf[o..o + 32]));
        }

        Ok(out)
    }
}

fn read_u32_le(b: &[u8]) -> u32 {
    let mut a = [0u8; 4];
    a.copy_from_slice(b);
    u32::from_le_bytes(a)
}

/// A single message call or contract creation to execute.
pub struct CallRequest {
    pub caller: [u8; 20],
    pub to: [u8; 20],
    pub data: Vec<u8>,
    pub gas_limit: u64,
    pub value: [u8; 32],
    pub spec: SpecId,
    pub chain_id: u64,
    pub block_number: u64,
    pub block_timestamp: u64,
    pub block_gas_limit: u64,
    pub coinbase: [u8; 20],
    /// See [`flags`].
    pub flags: u32,
    /// Fee market, access list and typed-transaction fields. Defaults to the
    /// part-1/part-2 behaviour (everything zero, no lists).
    pub extras: TxExtras,
}

impl CallRequest {
    #[inline]
    pub fn is_create(&self) -> bool {
        self.flags & flags::CREATE != 0
    }
    #[inline]
    pub fn wants_commit(&self) -> bool {
        self.flags & flags::COMMIT != 0
    }
    #[inline]
    pub fn checks_nonce(&self) -> bool {
        self.flags & flags::CHECK_NONCE != 0
    }
}

/// Apply the block environment for one request.
///
/// Split out so the fresh-EVM and persistent-EVM paths cannot drift; the base
/// fee in particular used to be pinned to zero in two separate places.
/// `blob_fraction` comes from `CfgEnv::blob_base_fee_update_fraction()`, which is
/// spec aware (Cancun vs Prague), so the blob gas price is revm's.
///
/// **Every field is assigned on every call, never conditionally.** The executor
/// is persistent (see [`CallExecutor`]), so a field that is only written when
/// the caller supplies it keeps the *previous* call's value, and a block
/// environment that depends on what was executed before it is not a block
/// environment. `excess_blob_gas` used to be written that way.
fn apply_block(block: &mut BlockEnv, blob_fraction: u64, req: &CallRequest) {
    block.number = U256::from(req.block_number);
    block.timestamp = U256::from(req.block_timestamp);
    block.gas_limit = req.block_gas_limit;
    block.beneficiary = Address::from(req.coinbase);
    // Always `Some`: revm's `PREVRANDAO` instruction unwraps it, and `None` is
    // reserved for a pre-merge block environment this package does not build.
    // Absent means zero, which is revm's own `BlockEnv` default.
    block.prevrandao = Some(req.extras.prev_randao.unwrap_or(B256::ZERO));
    if !FEES_ENABLED {
        block.basefee = 0;
        return;
    }
    block.basefee = req.extras.basefee;
    // Absent means zero excess, whose blob gas price is the 1 wei minimum, i.e.
    // revm's default for a block that carries no blob gas.
    block.set_blob_excess_gas_and_price(req.extras.excess_blob_gas.unwrap_or(0), blob_fraction);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/// The concrete context type (mainnet envs, host-backed database).
pub type EvmContext<H> = Context<BlockEnv, TxEnv, CfgEnv, HostDatabase<H>, Journal<HostDatabase<H>>, ()>;

/// The concrete EVM type, mainnet instructions with a fixed precompile set.
pub type HostEvm<H> = Evm<
    EvmContext<H>,
    (),
    EthInstructions<EthInterpreter, EvmContext<H>>,
    FixedPrecompiles,
    EthFrame<EthInterpreter>,
>;

/// Holds one EVM instance across many calls.
///
/// Building a fresh `Context`, `Journal`, instruction table, precompile map and
/// frame stack per call costs roughly 1 microsecond and dominates a small
/// `eth_call`, so the instance is kept alive and only the block and transaction
/// environments are rewritten. The spike proved the two produce byte-identical
/// outcomes over 127,170 calls, so only the setup cost differs.
pub struct CallExecutor<H: HostDb> {
    evm: HostEvm<H>,
}

impl<H: HostDb> CallExecutor<H> {
    pub fn new(host: H, spec: SpecId, chain_id: u64) -> Self {
        let ctx = Context::mainnet()
            .with_db(HostDatabase::new(host))
            .modify_cfg_chained(|c| {
                c.spec = spec;
                c.chain_id = chain_id;
                // Default is `eth_call` semantics: the caller is not required
                // to have a valid nonce. `flags::CHECK_NONCE` opts a real
                // transaction back in, per request.
                c.disable_nonce_check = true;
                c.tx_chain_id_check = false;
            });

        // NOTE: deliberately *not* `ctx.build_mainnet()`.
        //
        // `MainBuilder::build_mainnet` hardcodes `precompiles: EthPrecompiles::new(spec)`,
        // which calls `Precompiles::new(..)` and therefore statically references every
        // precompile function revm has. Building through it and then overwriting the
        // `precompiles` field is too late: the reference already exists, so LTO keeps
        // the whole crypto surface and any size trimming is fiction. Constructing
        // `Evm` directly is the only way to keep an unused precompile unreachable.
        //
        // This build ships every precompile anyway (ADR 0001), so the size point
        // is moot here, but the second half is not: `FixedPrecompiles` also stops
        // `EthPrecompiles::set_spec` from rebuilding the whole precompile map on
        // every single transaction, which `pre_execution::load_accounts` would
        // otherwise do. `run` still delegates to the stock `EthPrecompiles`, so
        // dispatch and gas accounting are unmodified revm.
        let evm = Evm::new(
            ctx,
            EthInstructions::new_mainnet_with_spec(spec),
            FixedPrecompiles::new(precompiles_for(spec), spec),
        );
        Self { evm }
    }

    /// Apply one request's environment to the persistent EVM.
    ///
    /// Shared by both execution paths, and every field it touches is written
    /// unconditionally. The executor outlives the request, so "leave it alone
    /// when the caller did not ask" means "inherit it from whatever ran last",
    /// which is a cross-call leak rather than a default.
    fn apply_env(&mut self, req: &CallRequest) {
        let blob_fraction = self.evm.ctx.cfg.blob_base_fee_update_fraction();
        apply_block(&mut self.evm.ctx.block, blob_fraction, req);
        self.evm.ctx.cfg.disable_nonce_check = !req.checks_nonce();

        let switches = ValidationSwitches::from_flags(req.flags);
        #[cfg(feature = "relaxed-validation")]
        {
            self.evm.ctx.cfg.disable_base_fee = switches.base_fee;
            self.evm.ctx.cfg.disable_balance_check = switches.balance;
            self.evm.ctx.cfg.disable_block_gas_limit = switches.block_gas_limit;
        }
        // Without the feature the `CfgEnv` fields do not exist, so the request
        // asked for a capability this artifact does not have. It is ignored, and
        // the check it asked to skip then rejects the transaction with revm's own
        // reason: loud, and never a silently different number.
        let _ = switches;
    }

    /// Spec is fixed at construction; changing it requires a new executor.
    pub fn execute(&mut self, req: &CallRequest) -> Vec<u8> {
        self.apply_env(req);

        let tx = match build_tx(req) {
            Ok(tx) => tx,
            Err(e) => return encode_validation_error(&e),
        };
        let effective_gas_price = if EMIT_EFFECTIVE_GAS_PRICE {
            tx.effective_gas_price(req.extras.basefee as u128)
        } else {
            0
        };
        self.evm.ctx.journaled_state.database.begin_tx();
        match self.evm.transact(tx) {
            Ok(res) => {
                let blob = encode_outcome(
                    &res.result,
                    &res.state,
                    &self.evm.ctx.journaled_state.database.original_code_hash,
                    effective_gas_price,
                );
                if COMMIT_ENABLED && req.wants_commit() {
                    self.evm.ctx.journaled_state.database.commit(res.state);
                }
                blob
            }
            Err(e) => encode_validation_error(&format!("{e:?}")),
        }
    }

    /// Lighter `eth_call` path: identical execution, but the state map is
    /// dropped instead of being sorted and encoded.
    ///
    /// Returns only the head of the outcome blob (status, gas, return data). It
    /// never commits. The simulation switches are resolved by
    /// [`CallExecutor::apply_env`], exactly as on the full path: which
    /// validations run is a property of the request, not of which encoding the
    /// caller wanted back.
    pub fn execute_light(&mut self, req: &CallRequest) -> Vec<u8> {
        self.apply_env(req);

        let tx = match build_tx(req) {
            Ok(tx) => tx,
            Err(e) => return encode_validation_error(&e),
        };
        let out = self.evm.transact_one(tx);
        // `finalize` still has to run: it clears the journal for the next call.
        // It is O(1) (a `mem::take`); the cost this path avoids is sorting and
        // serialising the taken map, not producing it.
        let _state = self.evm.finalize();
        match out {
            Ok(result) => encode_outcome_light(&result),
            Err(e) => encode_validation_error(&format!("{e:?}")),
        }
    }
}

/// Build the `TxEnv` for one request.
///
/// Nothing about the fee market is computed here. `gas_price` doubles as
/// `maxFeePerGas` in revm (see `Transaction::max_fee_per_gas`), and the
/// effective gas price, the up-front charge, the refund and the coinbase credit
/// are all revm's own, in `pre_execution::deduct_caller` and
/// `post_execution::reward_beneficiary`.
///
/// `tx_type` is left for revm's `derive_tx_type` unless the caller states it,
/// because that derivation is the part most easily got wrong by hand.
fn build_tx(req: &CallRequest) -> Result<TxEnv, String> {
    let kind = if req.is_create() {
        TxKind::Create
    } else {
        TxKind::Call(Address::from(req.to))
    };
    if !FEES_ENABLED {
        // Byte-for-byte the part-2 transaction, so the ablated build is a fair
        // baseline for the size delta rather than "the new code with zeros in it".
        return TxEnv::builder()
            .caller(Address::from(req.caller))
            .kind(kind)
            .data(req.data.clone().into())
            .gas_limit(req.gas_limit)
            .gas_price(0)
            .gas_priority_fee(None)
            .value(U256::from_be_bytes(req.value))
            .chain_id(Some(req.chain_id))
            .build()
            .map_err(|e| format!("{e:?}"));
    }
    let x = &req.extras;
    TxEnv::builder()
        .tx_type(x.tx_type)
        .caller(Address::from(req.caller))
        .kind(kind)
        .data(req.data.clone().into())
        .gas_limit(req.gas_limit)
        .gas_price(x.gas_price)
        .gas_priority_fee(x.gas_priority_fee)
        .nonce(x.nonce)
        .access_list(x.access_list.clone())
        .blob_hashes(x.blob_hashes.clone())
        .max_fee_per_blob_gas(x.max_fee_per_blob_gas)
        .authorization_list(x.authorization_list.clone())
        .value(U256::from_be_bytes(req.value))
        .chain_id(Some(req.chain_id))
        .build()
        .map_err(|e| format!("{e:?}"))
}

/// Encode a pre-execution failure (status 3) with the message in the return-data
/// slot. Public so the wasm layer can report a malformed extras blob the same way
/// revm reports a rejected transaction, rather than trapping.
pub fn encode_validation_error(msg: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(msg.len() + 32);
    out.push(3u8);
    out.extend_from_slice(&0u64.to_le_bytes());
    out.extend_from_slice(&0u64.to_le_bytes());
    out.extend_from_slice(&0u64.to_le_bytes());
    out.extend_from_slice(&(msg.len() as u32).to_le_bytes());
    out.extend_from_slice(msg.as_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // logs
    out.extend_from_slice(&0u32.to_le_bytes()); // accounts
    if EMIT_EFFECTIVE_GAS_PRICE {
        out.extend_from_slice(&0u128.to_be_bytes()); // effective gas price
    }
    out
}

// ---------------------------------------------------------------------------
// Standalone ecrecover
// ---------------------------------------------------------------------------

/// Recover the signer address from `(hash, v, r, s)`.
///
/// This is the same `k256` routine the `0x01` precompile calls, reached without
/// building a transaction, a journal or an interpreter frame. `v` is the
/// Ethereum-style recovery id (27 or 28; 0 or 1 are also accepted). Returns
/// `None` when the signature does not recover, exactly as the precompile's
/// empty-output case.
pub fn ecrecover_address(hash: &[u8; 32], v: u8, r: &[u8; 32], s: &[u8; 32]) -> Option<[u8; 20]> {
    let recid = match v {
        27 | 28 => v - 27,
        0 | 1 => v,
        _ => return None,
    };
    let mut sig = [0u8; 64];
    sig[0..32].copy_from_slice(r);
    sig[32..64].copy_from_slice(s);
    let out = revm::precompile::secp256k1::ecrecover(&sig.into(), recid, &(*hash).into()).ok()?;
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&out.0[12..32]);
    Some(addr)
}

// ---------------------------------------------------------------------------
// Size-ablation levers
//
// These exist so the report can *measure* what each addition costs in the wasm
// artifact instead of guessing. They are compile-time constants, so LTO deletes
// the disabled branch entirely. Measurement only; never ship an ablated build.
// ---------------------------------------------------------------------------

/// `--features ablate-outcome-v1` reverts the blob to outcome format v1:
/// no logs and no code bytes.
pub const EMIT_LOGS_AND_CODE: bool = !cfg!(feature = "ablate-outcome-v1");
/// `--features ablate-commit` makes `flags::COMMIT` a no-op, so the whole
/// `DatabaseCommit` path becomes unreachable and LTO drops it.
pub const COMMIT_ENABLED: bool = !cfg!(feature = "ablate-commit");
/// `--features ablate-bloom` stops emitting the 256-byte receipts bloom, so its
/// cost in the artifact can be measured rather than guessed.
pub const EMIT_BLOOM: bool = !cfg!(feature = "ablate-bloom");
/// `--features ablate-fees` reverts to part 2's transaction shape: gas price 0,
/// no priority fee, no access list, no blob hashes, no authorization list, base
/// fee 0. The extras decoder and every list field become unreachable, so LTO
/// removes them and the size cost of section 1 and 2 can be measured.
pub const FEES_ENABLED: bool = !cfg!(feature = "ablate-fees");
/// `--features ablate-egp` drops the trailing effective-gas-price field, so its
/// cost can be measured on its own rather than hidden inside the fee delta.
pub const EMIT_EFFECTIVE_GAS_PRICE: bool = !cfg!(feature = "ablate-egp");

/// Encode the fixed head of an outcome blob: everything up to and including the
/// return data. Shared by the full and the light encodings so the two can never
/// drift, and so `harness/gas-snapshot.mjs` can compare gas across format
/// versions by looking only at this prefix.
fn encode_head(out: &mut Vec<u8>, result: &ExecutionResult) {
    let (status, gas, ret): (u8, _, &[u8]) = match result {
        ExecutionResult::Success { gas, output, .. } => {
            let b = match output {
                Output::Call(b) => b.as_ref(),
                Output::Create(b, _) => b.as_ref(),
            };
            (0, gas, b)
        }
        ExecutionResult::Revert { gas, output, .. } => (1, gas, output.as_ref()),
        ExecutionResult::Halt { gas, .. } => (2, gas, &[][..]),
    };
    out.push(status);
    out.extend_from_slice(&gas.tx_gas_used().to_le_bytes());
    out.extend_from_slice(&gas.total_gas_spent().to_le_bytes());
    out.extend_from_slice(&gas.final_refunded().to_le_bytes());
    out.extend_from_slice(&(ret.len() as u32).to_le_bytes());
    out.extend_from_slice(ret);
}

/// Head only: status, gas and return data. Used by the light `eth_call` path,
/// which never looks at state.
pub fn encode_outcome_light(result: &ExecutionResult) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    encode_head(&mut out, result);
    out
}

/// Compact binary encoding of the call outcome. One `Uint8Array` crosses the
/// boundary per call, rather than a JS object graph.
///
/// Format v2. v1 was identical up to and including the return data, then went
/// straight to the account list, and carried no logs and no code bytes.
///
/// ```text
/// u8   status: 0 = success, 1 = revert, 2 = halt, 3 = validation error
/// u64  gas used (little-endian) == ResultGas::tx_gas_used()
/// u64  total gas spent before refunds (little-endian)
/// u64  refunded gas (little-endian)
/// u32  return data length, then bytes
/// u32  number of logs, then per log, in emission order:
///        [20] emitting address
///        u8   number of topics (0..=4)
///        [32] * that many topics
///        u32  data length, then bytes
///      if the log count is non-zero, [256] receipts logs bloom
/// u32  number of changed accounts, then per account:
///        [20] address
///        u8   flags: bit0 selfdestructed, bit1 touched, bit2 created,
///                    bit3 code changed (code bytes follow),
///                    bit4 deleted (SELFDESTRUCT or EIP-161 empty-account clear)
///        [32] balance (big-endian)
///        u64  nonce (little-endian)
///        [32] code hash
///        if bit3: u32 code length, then bytes
///        u32  number of changed storage slots, then per slot:
///               [32] key (big-endian)
///               [32] present value (big-endian)
/// [16] effective gas price (big-endian), i.e. what the sender actually paid
///      per unit of gas: revm's own `Transaction::effective_gas_price`
/// ```
///
/// Logs are *not* sorted: emission order is the semantics that receipts and
/// `eth_getLogs` need. revm hands them over already filtered, because a reverted
/// checkpoint truncates the journal's log vector, so a sub-call that emits and
/// then reverts contributes nothing here. Accounts and slots stay sorted, so the
/// blob is still byte-for-byte diffable between native and wasm.
///
/// `original_code_hash` maps an address to the code hash it had before this
/// transaction (see [`HostDatabase::original_code_hash`]); an absent entry means
/// `KECCAK_EMPTY`. Code bytes are emitted exactly when the account's current
/// code hash differs from that, which is what makes a `CREATE` reconstructable
/// by the host.
pub fn encode_outcome(
    result: &ExecutionResult,
    state: &revm::state::EvmState,
    original_code_hash: &AddressMap<B256>,
    effective_gas_price: u128,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    encode_head(&mut out, result);

    if EMIT_LOGS_AND_CODE {
        let logs = result.logs();
        out.extend_from_slice(&(logs.len() as u32).to_le_bytes());
        for log in logs {
            out.extend_from_slice(log.address.as_slice());
            let topics = log.topics();
            out.push(topics.len() as u8);
            for t in topics {
                out.extend_from_slice(t.as_slice());
            }
            out.extend_from_slice(&(log.data.data.len() as u32).to_le_bytes());
            out.extend_from_slice(log.data.data.as_ref());
        }
        // Receipts bloom, emitted only when there is at least one log: the
        // zero-log bloom is 256 zero bytes and the host already knows that, so
        // paying 256 bytes on every `eth_call` for it would be waste. The filter
        // itself is alloy's `Bloom::accrue_logs`, i.e. the same code path the
        // rest of the Ethereum Rust stack uses, not a reimplementation.
        if EMIT_BLOOM && !logs.is_empty() {
            let mut bloom = Bloom::ZERO;
            bloom.accrue_logs(logs);
            out.extend_from_slice(bloom.as_slice());
        }
    }

    // Deterministic ordering: sort by address so native and wasm produce
    // byte-identical output regardless of hash map iteration order.
    let mut accounts: Vec<_> = state.iter().collect();
    accounts.sort_by_key(|(addr, _)| **addr);

    out.extend_from_slice(&(accounts.len() as u32).to_le_bytes());
    for (addr, account) in accounts {
        out.extend_from_slice(addr.as_slice());

        let before = original_code_hash
            .get(addr)
            .copied()
            .unwrap_or(KECCAK_EMPTY);
        let code_changed = EMIT_LOGS_AND_CODE && account.info.code_hash != before;

        let mut flags = 0u8;
        if account.is_selfdestructed() {
            flags |= 1;
        }
        if account.is_touched() {
            flags |= 2;
        }
        if account.is_created() {
            flags |= 4;
        }
        if code_changed {
            flags |= 8;
        }
        if account_is_deleted(account) {
            // Stated explicitly so a host that applies the blob itself does not
            // have to re-derive EIP-161 state clearing and get it subtly wrong.
            flags |= 16;
        }
        out.push(flags);
        out.extend_from_slice(&account.info.balance.to_be_bytes::<32>());
        out.extend_from_slice(&account.info.nonce.to_le_bytes());
        out.extend_from_slice(account.info.code_hash.as_slice());

        if code_changed {
            // `set_code` always stores the bytecode alongside the hash, so a
            // changed hash implies `info.code` is populated. The empty fallback
            // is unreachable in practice and is here only so a future revm change
            // degrades to "no bytes" rather than to a panic.
            let bytes: &[u8] = match account.info.code.as_ref() {
                Some(bc) => bc.original_byte_slice(),
                None => &[],
            };
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            out.extend_from_slice(bytes);
        }

        let mut slots: Vec<_> = account
            .storage
            .iter()
            .filter(|(_, slot)| slot.is_changed())
            .collect();
        slots.sort_by_key(|(k, _)| **k);
        out.extend_from_slice(&(slots.len() as u32).to_le_bytes());
        for (key, slot) in slots {
            out.extend_from_slice(&key.to_be_bytes::<32>());
            out.extend_from_slice(&slot.present_value.to_be_bytes::<32>());
        }
    }

    // Trailing, so anything that decodes v2 sequentially and stops at the end of
    // the account list is unaffected. It is revm's `effective_gas_price`, not a
    // second implementation of min(maxFee, basefee + tip).
    if EMIT_EFFECTIVE_GAS_PRICE {
        out.extend_from_slice(&effective_gas_price.to_be_bytes());
    }
    out
}

#[cfg(not(any(
    feature = "precompiles-none",
    feature = "precompiles-common",
    feature = "precompiles-all"
)))]
compile_error!("exactly one precompiles-* feature must be enabled");
