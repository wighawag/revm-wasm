---
"revm-wasm": patch
---

Fix intrinsic gas computed at wrong spec (GitHub issue #4)

`CallExecutor::new` set `CfgEnv::spec` directly, which left `CfgEnv::gas_params`
at the `Context::mainnet()` default (`SpecId::OSAKA`). The intrinsic-gas table
therefore always carried EIP-3860's initcode word cost (introduced in Shanghai)
and EIP-7623's calldata floor (introduced in Prague), regardless of the spec
the caller requested.

This caused two observable bugs on pre-Shanghai and pre-Prague forks:

1. `Outcome.gasUsed` reported the EIP-7623 calldata floor on specs that predate
   Prague.
2. EIP-3860's initcode word cost was *charged* on specs that predate Shanghai
   (`BERLIN`, `LONDON`, `MERGE`).

Opcode gating was unaffected because the instruction table is built from the
correct spec; only the intrinsic-gas path used the stale `gas_params`.

The fix replaces `c.spec = spec` with `c.set_spec_and_mainnet_gas_params(spec)`,
which rebuilds the gas table for the requested spec (and enables EIP-8037/EIP-2780
for AMSTERDAM and later).