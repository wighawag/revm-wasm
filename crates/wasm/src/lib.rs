//! The wasm32 ABI surface of `revm-wasm`.
//!
//! # Why this is a raw C ABI and not wasm-bindgen
//!
//! The feasibility spike used `wasm-bindgen`. This package does not, and the
//! reason is instance isolation rather than taste. `wasm-bindgen --target web`
//! emits an ES module holding the instance's exports in a **module-level**
//! `let wasm`, and routes imported host functions through **module-level**
//! bindings. Two instances loaded in one JS realm therefore share both. The
//! spike hit exactly that: loading two builds in one process silently made the
//! second one's linear memory answer the first one's state reads. It produced
//! plausible numbers with the wrong sign and was invisible, and the workaround
//! was a `?dist=` query string that forced a fresh module instance per build.
//!
//! A published package cannot ship that hazard to consumers. With a raw ABI the
//! imports are supplied per `WebAssembly.instantiate`, so every instance is
//! bound to its own host and its own memory by construction, and the whole class
//! of bug is gone rather than worked around. It also removes `wasm-bindgen` from
//! the build pipeline, so one fewer tool version moves the output bytes.
//!
//! See `docs/adr/0002-raw-abi-no-wasm-bindgen.md`.
//!
//! # Boundary design, which is a measured decision and is unchanged
//!
//! * Every state access is exactly one wasm-to-JS call taking **integer
//!   arguments only**. Arguments are pointers into linear memory; the host
//!   writes its answer directly into that memory. Nothing is serialised, boxed
//!   or allocated per access on either side. The spike measured the crossing
//!   itself at ~0.51 microseconds against a null host, of which ~0.8
//!   microseconds *more* was the JS side's own key construction, so the shape
//!   here is not the thing worth changing.
//! * Per call, exactly one request blob goes in and one outcome blob comes out.
//!   Both live in buffers this module reuses, so a steady-state call allocates
//!   nothing on the wasm side for the transport itself.

use core::cell::RefCell;
use revm_wasm_core::{
    ecrecover_address, encode_validation_error, revm::primitives::hardfork::SpecId, CallExecutor,
    CallRequest, HostDb, TxExtras,
};

// ---------------------------------------------------------------------------
// Host imports
// ---------------------------------------------------------------------------

// The imported host interface.
//
// These land in the wasm import section as module "revm_wasm_host", so the
// embedder supplies them in the `imports` object at instantiation time. The
// signatures are the spike's, byte layouts included, because they are a
// measured performance decision: integer pointers, nothing marshalled.
#[link(wasm_import_module = "revm_wasm_host")]
extern "C" {
    /// Writes 32-byte balance (big-endian) | 8-byte LE nonce | 32-byte code hash
    /// at `out_ptr`. Returns 1 if the account exists, 0 otherwise.
    fn basic(addr_ptr: u32, out_ptr: u32) -> u32;
    /// Writes the 32-byte big-endian storage value at `out_ptr`.
    fn storage(addr_ptr: u32, key_ptr: u32, out_ptr: u32);
    /// Returns the byte length of the code with the hash at `hash_ptr`.
    fn code_len(hash_ptr: u32) -> u32;
    /// Copies that code into `out_ptr`.
    fn code_copy(hash_ptr: u32, out_ptr: u32);
    /// Writes the 32-byte block hash at `out_ptr`. The block number crosses as
    /// two `u32` halves to avoid a BigInt conversion per call on the JS side.
    fn block_hash(num_lo: u32, num_hi: u32, out_ptr: u32);

    // -- write side, reached only when a request sets flag bit 0 (COMMIT) --

    /// Insert or overwrite the 72-byte packed account at `addr_ptr`.
    fn set_account(addr_ptr: u32, packed_ptr: u32);
    /// Store `len` bytes of code at `code_ptr` under the hash at `hash_ptr`.
    fn set_code(hash_ptr: u32, code_ptr: u32, len: u32);
    /// Write one 32-byte storage value.
    fn set_storage(addr_ptr: u32, key_ptr: u32, val_ptr: u32);
    /// Drop every storage slot of an account.
    fn clear_storage(addr_ptr: u32);
    /// Remove the account, so a later `basic` reports it as non-existent.
    fn remove_account(addr_ptr: u32);
}

/// Zero-sized: the host lives on the JS side, bound to this instance by the
/// imports object. Nothing about it needs to be carried in linear memory.
struct ImportedHost;

impl HostDb for ImportedHost {
    #[inline]
    fn basic(&mut self, address: &[u8; 20], out: &mut [u8; 72]) -> bool {
        unsafe { basic(address.as_ptr() as u32, out.as_mut_ptr() as u32) != 0 }
    }

    #[inline]
    fn storage(&mut self, address: &[u8; 20], key: &[u8; 32], out: &mut [u8; 32]) {
        unsafe {
            storage(
                address.as_ptr() as u32,
                key.as_ptr() as u32,
                out.as_mut_ptr() as u32,
            )
        }
    }

    #[inline]
    fn code_len(&mut self, code_hash: &[u8; 32]) -> usize {
        unsafe { code_len(code_hash.as_ptr() as u32) as usize }
    }

    #[inline]
    fn code_copy(&mut self, code_hash: &[u8; 32], out: &mut [u8]) {
        unsafe { code_copy(code_hash.as_ptr() as u32, out.as_mut_ptr() as u32) }
    }

    #[inline]
    fn block_hash(&mut self, number: u64, out: &mut [u8; 32]) {
        unsafe {
            block_hash(
                number as u32,
                (number >> 32) as u32,
                out.as_mut_ptr() as u32,
            )
        }
    }

    #[inline]
    fn set_account(&mut self, address: &[u8; 20], packed: &[u8; 72]) {
        unsafe { set_account(address.as_ptr() as u32, packed.as_ptr() as u32) }
    }

    #[inline]
    fn set_code(&mut self, code_hash: &[u8; 32], code: &[u8]) {
        unsafe {
            set_code(
                code_hash.as_ptr() as u32,
                code.as_ptr() as u32,
                code.len() as u32,
            )
        }
    }

    #[inline]
    fn set_storage(&mut self, address: &[u8; 20], key: &[u8; 32], value: &[u8; 32]) {
        unsafe {
            set_storage(
                address.as_ptr() as u32,
                key.as_ptr() as u32,
                value.as_ptr() as u32,
            )
        }
    }

    #[inline]
    fn clear_storage(&mut self, address: &[u8; 20]) {
        unsafe { clear_storage(address.as_ptr() as u32) }
    }

    #[inline]
    fn remove_account(&mut self, address: &[u8; 20]) {
        unsafe { remove_account(address.as_ptr() as u32) }
    }
}

// ---------------------------------------------------------------------------
// Measurement-only getrandom stub
//
// See the note on the `getrandom` dependency in Cargo.toml. An EVM never asks
// for randomness, so this is unreachable; it exists so that `--features
// measure-tracer` links at all on wasm32-unknown-unknown.
// ---------------------------------------------------------------------------
#[cfg(feature = "measure-tracer")]
fn unsupported_getrandom(_dest: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
#[cfg(feature = "measure-tracer")]
getrandom::register_custom_getrandom!(unsupported_getrandom);

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/// Version of the *call ABI*: the export names, the request blob layout and the
/// meaning of the return values. Bumped only for a change that an existing
/// loader could not survive.
pub const ABI_VERSION: u32 = 1;

/// Version of the *outcome blob* layout (see `revm_wasm_core::encode_outcome`).
///
/// v1 read-only, v2 added logs and code bytes, v3 added the conditional logs
/// bloom and the trailing effective gas price. The head has been at identical
/// byte offsets across all three, and that is the discipline: the head is fixed,
/// new sections are appended, and this number is readable at runtime so a
/// decoder can refuse what it does not understand instead of misreading it.
pub const OUTCOME_FORMAT_VERSION: u32 = 3;

/// Version of the request blob layout. Its head is fixed at offsets 0..140.
pub const REQUEST_FORMAT_VERSION: u8 = 1;

// ---------------------------------------------------------------------------
// Request blob
// ---------------------------------------------------------------------------

/// Fixed-size head of the request blob. Everything below offset 140 is at a
/// stable offset for the life of `REQUEST_FORMAT_VERSION`; new fields are
/// appended after the variable-length sections, never inserted.
///
/// ```text
/// 0    u8   version (REQUEST_FORMAT_VERSION)
/// 1    u8   spec id (revm SpecId discriminant)
/// 2    u16  reserved, must be 0
/// 4    u32  flags (see revm_wasm_core::flags; bits 4+ unallocated)
/// 8    u64  gas limit
/// 16   u64  chain id
/// 24   u64  block number
/// 32   u64  block timestamp
/// 40   u64  block gas limit
/// 48   [20] caller
/// 68   [20] to (ignored when the CREATE flag is set)
/// 88   [20] coinbase
/// 108  [32] value, big-endian
/// 140  u32  calldata / init-code length, then that many bytes
/// +    u32  extras length (0 for none), then that many bytes
/// ```
const REQ_HEAD: usize = 140;

fn u32_le(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

fn u64_le(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[..8]);
    u64::from_le_bytes(a)
}

/// `SpecId` discriminants. See `revm::primitives::hardfork::SpecId`:
/// 0 FRONTIER .. 11 CANCUN, 12 PRAGUE, 13 OSAKA, 14 AMSTERDAM. An unknown value
/// falls back to CANCUN rather than trapping, so a newer caller against an older
/// artifact degrades instead of crashing the page.
fn spec_from_u8(spec: u8) -> SpecId {
    SpecId::try_from_u8(spec).unwrap_or(SpecId::CANCUN)
}

fn decode_request(buf: &[u8]) -> Result<CallRequest, String> {
    if buf.len() < REQ_HEAD + 4 {
        return Err(format!("RequestTooShort({})", buf.len()));
    }
    if buf[0] != REQUEST_FORMAT_VERSION {
        return Err(format!("RequestBadVersion({})", buf[0]));
    }

    let data_len = u32_le(&buf[REQ_HEAD..REQ_HEAD + 4]) as usize;
    let data_at = REQ_HEAD + 4;
    if buf.len() < data_at + data_len + 4 {
        return Err(format!("RequestTruncated({})", buf.len()));
    }
    let extras_at = data_at + data_len;
    let extras_len = u32_le(&buf[extras_at..extras_at + 4]) as usize;
    if buf.len() < extras_at + 4 + extras_len {
        return Err(format!("RequestTruncated({})", buf.len()));
    }

    let extras = if extras_len == 0 {
        TxExtras::default()
    } else {
        TxExtras::decode(&buf[extras_at + 4..extras_at + 4 + extras_len])?
    };

    let mut req = CallRequest {
        caller: [0u8; 20],
        to: [0u8; 20],
        data: buf[data_at..data_at + data_len].to_vec(),
        gas_limit: u64_le(&buf[8..16]),
        value: [0u8; 32],
        spec: spec_from_u8(buf[1]),
        chain_id: u64_le(&buf[16..24]),
        block_number: u64_le(&buf[24..32]),
        block_timestamp: u64_le(&buf[32..40]),
        block_gas_limit: u64_le(&buf[40..48]),
        coinbase: [0u8; 20],
        flags: u32_le(&buf[4..8]),
        extras,
    };
    req.caller.copy_from_slice(&buf[48..68]);
    req.to.copy_from_slice(&buf[68..88]);
    req.coinbase.copy_from_slice(&buf[88..108]);
    req.value.copy_from_slice(&buf[108..140]);
    Ok(req)
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/// Per-instance state. `thread_local!` is per wasm instance because a wasm
/// instance is a thread; two `WebAssembly.Instance`s never share it.
struct State {
    /// Reused inbound buffer. Grows to the largest request seen and stays there,
    /// so a steady-state call does not allocate for transport.
    request: Vec<u8>,
    /// Reused outbound buffer, same reasoning.
    outcome: Vec<u8>,
    /// Spec and chain id are baked into the executor's `CfgEnv` at construction,
    /// so a change to either has to rebuild it. Everything else is per request.
    executor: Option<(u8, u64, CallExecutor<ImportedHost>)>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        request: Vec::new(),
        outcome: Vec::new(),
        executor: None,
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// Version of the call ABI. Read this before anything else.
#[no_mangle]
pub extern "C" fn revm_wasm_abi_version() -> u32 {
    ABI_VERSION
}

/// Version of the outcome blob layout, so a decoder can refuse a format it does
/// not understand rather than misread it.
#[no_mangle]
pub extern "C" fn revm_wasm_outcome_format_version() -> u32 {
    OUTCOME_FORMAT_VERSION
}

/// Static, NUL-free JSON describing what this artifact actually is: revm
/// version, the exact revm revision it was built from, and the build
/// configuration. Exposed so a downstream bug report can state precisely what
/// was running.
static INFO: &str = concat!(
    "{\"revm\":\"",
    env!("REVM_WASM_REVM_VERSION"),
    "\",\"revmRev\":\"",
    env!("REVM_WASM_REVM_REV"),
    "\",\"build\":\"",
    env!("REVM_WASM_BUILD_CONFIG"),
    "\"}"
);

#[no_mangle]
pub extern "C" fn revm_wasm_info_ptr() -> u32 {
    INFO.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn revm_wasm_info_len() -> u32 {
    INFO.len() as u32
}

/// Reserve `len` bytes of request buffer and return a pointer to it.
///
/// The caller writes exactly `len` bytes there and then calls
/// [`revm_wasm_execute`]. **The pointer is invalidated by any later call into
/// this module**, and writing into it may have grown linear memory, so a JS
/// caller must re-read `memory.buffer` after this returns.
#[no_mangle]
pub extern "C" fn revm_wasm_request_buffer(len: u32) -> u32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let len = len as usize;
        if s.request.len() < len {
            s.request.resize(len, 0);
        }
        s.request.as_mut_ptr() as u32
    })
}

/// Pointer to the outcome buffer. Valid until the next call into this module.
#[no_mangle]
pub extern "C" fn revm_wasm_outcome_ptr() -> u32 {
    STATE.with(|s| s.borrow().outcome.as_ptr() as u32)
}

/// Execute the request currently in the request buffer (its first `len` bytes)
/// and return the byte length of the outcome blob, which is then at
/// [`revm_wasm_outcome_ptr`].
///
/// A malformed request is reported the same way revm reports a rejected
/// transaction: status 3 with the reason in the return-data slot. It never
/// traps, because trapping a wasm instance is unrecoverable and a bad request is
/// a caller bug, not a machine fault.
#[no_mangle]
pub extern "C" fn revm_wasm_execute(len: u32) -> u32 {
    run(len, false)
}

/// Lighter read-only path: identical execution, but the state map is dropped
/// instead of being sorted and encoded, so the outcome is the head only (status,
/// gas, return data) with **no logs and no state**. Never commits.
///
/// Worth about 0.9 microseconds per call, which is 22% to 33% of the empty-call
/// floor. All of that saving is skipping the state encoding; the spike measured
/// relaxing transaction validation at 0.01 microseconds, i.e. nothing.
#[cfg(not(feature = "ablate-extra-exports"))]
#[no_mangle]
pub extern "C" fn revm_wasm_execute_light(len: u32) -> u32 {
    run(len, true)
}

fn run(len: u32, light: bool) -> u32 {
    STATE.with(|cell| {
        let mut s = cell.borrow_mut();
        let len = (len as usize).min(s.request.len());

        // Decoded out of the request buffer before the executor is touched, so
        // the borrow of `s.request` ends before `s.executor` is borrowed.
        let req = match decode_request(&s.request[..len]) {
            Ok(r) => r,
            Err(e) => {
                s.outcome = encode_validation_error(&e);
                return s.outcome.len() as u32;
            }
        };

        let spec_byte = s.request[1];
        let stale = match s.executor.as_ref() {
            Some((spec, chain, _)) => *spec != spec_byte || *chain != req.chain_id,
            None => true,
        };
        if stale {
            s.executor = Some((
                spec_byte,
                req.chain_id,
                CallExecutor::new(ImportedHost, req.spec, req.chain_id),
            ));
        }
        let exec = &mut s.executor.as_mut().unwrap().2;
        let out = if light {
            exec.execute_light(&req)
        } else {
            exec.execute(&req)
        };
        s.outcome = out;
        s.outcome.len() as u32
    })
}

/// Recover the signer address of `(hash, v, r, s)` without building a
/// transaction, a journal or an interpreter frame.
///
/// Reads 97 bytes from the request buffer: `[32] hash | [1] v | [32] r | [32] s`.
/// Writes the 20-byte address into the outcome buffer and returns 20, or returns
/// 0 when the signature does not recover.
///
/// This is the same `k256` code the `0x01` precompile runs, so it costs no extra
/// bytes in the artifact. **It is not a speedup**: the spike measured it at 1%
/// to 4% faster than going through the precompile, because a recovery is
/// ~450 microseconds of k256 and `transact()` is ~4 of them. Its value is that
/// it needs no database, no host callbacks, no gas limit, no block environment
/// and no journal, so a sender can be recovered before there is any state to run
/// the transaction against.
#[cfg(not(feature = "ablate-extra-exports"))]
#[no_mangle]
pub extern "C" fn revm_wasm_ecrecover() -> u32 {
    STATE.with(|cell| {
        let mut s = cell.borrow_mut();
        if s.request.len() < 97 {
            return 0;
        }
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&s.request[0..32]);
        let v = s.request[32];
        let mut r = [0u8; 32];
        r.copy_from_slice(&s.request[33..65]);
        let mut sig_s = [0u8; 32];
        sig_s.copy_from_slice(&s.request[65..97]);
        match ecrecover_address(&hash, v, &r, &sig_s) {
            Some(addr) => {
                s.outcome.clear();
                s.outcome.extend_from_slice(&addr);
                20
            }
            None => 0,
        }
    })
}
