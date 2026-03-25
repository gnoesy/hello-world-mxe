# hello-world-mxe — Encrypted Addition on Arcium

> Two numbers added inside Arcium MXE without either value being revealed. The simplest demonstration of encrypted computation on Solana.

[![Solana Devnet](https://img.shields.io/badge/Solana-devnet-9945FF)](https://explorer.solana.com/address/3TysCyYXyWpqNXDnQiwA4C2KiMSxGmBbTJADtGwFVeLr?cluster=devnet)
[![Arcium MXE](https://img.shields.io/badge/Arcium-MXE%20cluster%20456-00D4FF)](https://arcium.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.32.1-orange)](https://anchor-lang.com)
[![arcium-client](https://img.shields.io/badge/arcium--client-0.9.3-blue)](https://www.npmjs.com/package/@arcium-hq/client)

---

## Deployed Program

| Network | Program ID |
|---|---|
| **Solana Devnet** | [`3TysCyYXyWpqNXDnQiwA4C2KiMSxGmBbTJADtGwFVeLr`](https://explorer.solana.com/address/3TysCyYXyWpqNXDnQiwA4C2KiMSxGmBbTJADtGwFVeLr?cluster=devnet) |
| MXE Cluster | offset `456` (Arcium devnet) |

---

## What It Does

`add_together` takes two encrypted `u8` values, adds them inside the Arcium MXE, and returns the encrypted result. Neither input is ever decrypted outside the trusted execution environment.

```
Client encrypts val1, val2 with MXE public key (x25519-RescueCipher)
        │
        ▼
Solana: add_together instruction
        │  queue_computation — ciphertexts sent to Arcium cluster 456
        ▼
Arcium MXE
        │  computes val1 + val2 inside encrypted environment
        │  result re-encrypted with caller's public key
        ▼
Solana: add_together_callback
        │  emits SumEvent { sum: [u8;32], nonce: [u8;16] }
        ▼
Client decrypts SumEvent → plaintext result
```

---

## Quick Start

### Prerequisites

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Anchor (via avm)
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.32.1 && avm use 0.32.1

# Arcium CLI
cargo install arcium
```

### Setup

```bash
git clone https://github.com/gnoesy/hello-world-mxe
cd hello-world-mxe
yarn install

# Configure your devnet wallet in Anchor.toml (already set to devnet + cluster 456)
# Default wallet: ~/.config/solana/devnet.json
solana config set --url devnet
solana airdrop 2   # get devnet SOL if needed
```

### Run the Demo

```bash
npx ts-node --transpile-only scripts/run_computation.ts
```

Expected output:
```json
{"event":"computation_start","wallet":"devnet","pub":"4Y8R7..."}
{"event":"fetching_mxe_pubkey","cluster":456}
{"event":"submitting_computation","val1":"42","val2":"58","expectedSum":"100"}
{"event":"computation_queued","sig":"..."}
```

> Note: MXE computation finalisation requires the cluster to process the queue. On devnet this can take time or fail with `Custom:6300` (cluster busy). The queue submission itself is the meaningful on-chain action.

### Upload Circuit (first time only)

The `add_together.arcis` circuit must be uploaded to cluster 456 before computations work:

```bash
npx ts-node --transpile-only scripts/upload_circuit.ts
```

---

## ARCIS Circuit

Defined in `encrypted-ixs/src/lib.rs`:

```rust
pub struct InputValues {
    pub field_0: u8,
    pub field_1: u8,
}

#[instruction]
pub fn add_together(input_ctxt: Enc<Shared, InputValues>) -> Enc<Shared, u16> {
    let input = input_ctxt.to_arcis();
    let result = input.field_0 as u16 + input.field_1 as u16;
    input_ctxt.owner.from_arcis(result)
}
```

This function runs inside the MXE. The Solana program never sees `field_0` or `field_1` in plaintext.

---

## On-chain Instructions

| Instruction | Description |
|---|---|
| `init_add_together_comp_def` | Register computation definition on-chain (run once) |
| `add_together` | Queue encrypted computation with two `u8` ciphertexts |
| `add_together_callback` | MXE callback — emits `SumEvent { sum, nonce }` |

---

## Project Structure

```
hello-world-mxe/
├── programs/hello_world/src/lib.rs   # Solana Anchor program
├── encrypted-ixs/src/lib.rs          # ARCIS circuit (MXE computation logic)
├── scripts/
│   ├── run_computation.ts            # Demo: run encrypted addition end-to-end
│   └── upload_circuit.ts             # Upload add_together.arcis to cluster 456
├── build/
│   └── add_together.arcis            # Compiled ARCIS circuit binary
├── Anchor.toml                       # Devnet config, program IDs
└── Arcium.toml                       # MXE cluster config (offset: 456)
```

---

## Build from Source

```bash
# Build ARCIS circuit
arcium build

# Build Solana program
anchor build

# Deploy (requires existing MXE setup)
anchor deploy --provider.cluster devnet
```

---

## Tech Stack

- **Solana** + Anchor Framework 0.32.1
- **Arcium MXE** — Multi-party Execution Environment (cluster 456)
- **ARCIS** — Arcium circuit DSL for encrypted computation logic
- **x25519-RescueCipher** — client-side encryption before submission
- **arcium-client 0.9.3** — TypeScript SDK

---

## Related MXE Programs (same wallet)

| Program | Description | Program ID |
|---|---|---|
| [encrypted-defi-mxe](https://github.com/gnoesy/encrypted-defi-mxe) | Private order matching | `AmzMmGcKUqMWf57WPXhHBkE9QzrbXCc1emFK6hsVJTj7` |
| [private-voting-mxe](https://github.com/gnoesy/private-voting-mxe) | Anonymous governance | `S43YKqU6x229PdY5oUssPoD2UgH4EDUvugYos6WxvDY` |
| [encrypted-voting-mxe](https://github.com/gnoesy/encrypted-voting-mxe) | Sealed-bid auction | `FoCgMmXj37JaMcbYrAnBDCWaaQE6FYzEBzMuAkXBZ7XF` |
| [encrypted-identity-mxe](https://github.com/gnoesy/encrypted-identity-mxe) | zkKYC identity | `3zYA4ykzGofqeH6m6aET46AQNgBVtEa2XotAVX6TXgBV` |

---

## Devnet Explorer

- [Program Account](https://explorer.solana.com/address/3TysCyYXyWpqNXDnQiwA4C2KiMSxGmBbTJADtGwFVeLr?cluster=devnet)
- [Deployer Wallet](https://explorer.solana.com/address/4Y8R73V9QpmL2oUtS4LrwdZk3LrPRCLp7KGg2npPkB1u?cluster=devnet)
