/**
 * Arcium MXE 직접 computation 실행 스크립트
 * hello_world(add_together) + encrypted_defi(match_order) 두 프로그램 실행
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { HelloWorld } from "../target/types/hello_world";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumProgramId,
  getArciumProgram,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  x25519,
} from "@arcium-hq/client";

const LOG = path.join(os.homedir(), "arcium-farmer/logs/mpc_computation.jsonl");
fs.mkdirSync(path.dirname(LOG), { recursive: true });

function log(event: string, data: Record<string, unknown> = {}) {
  const entry = JSON.stringify({ event, ...data, ts: new Date().toISOString() });
  fs.appendFileSync(LOG, entry + "\n");
  console.log(entry);
}

async function withRpcRetry<T>(fn: () => Promise<T>, retries = 8): Promise<T> {
  let delayMs = 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const message = error?.message || String(error);
      if (attempt >= retries || !message.includes("429")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}

async function sendAndConfirmCompat(
  provider: anchor.AnchorProvider,
  tx: anchor.web3.Transaction,
  signers: anchor.web3.Signer[] = [],
  opts: anchor.web3.ConfirmOptions = {},
): Promise<string> {
  const commitment = opts.commitment || opts.preflightCommitment || "confirmed";
  const latest = await withRpcRetry(() =>
    provider.connection.getLatestBlockhash({ commitment }),
  );

  tx.feePayer ||= provider.publicKey;
  tx.recentBlockhash ||= latest.blockhash;
  tx.lastValidBlockHeight ||= latest.lastValidBlockHeight;

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  const signed = await provider.wallet.signTransaction(tx);
  const sig = await withRpcRetry(() =>
    provider.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: opts.skipPreflight,
      preflightCommitment: opts.preflightCommitment || commitment,
      maxRetries: opts.maxRetries,
    }),
  );

  await withRpcRetry(() =>
    provider.connection.confirmTransaction(
      {
        signature: sig,
        blockhash: tx.recentBlockhash,
        lastValidBlockHeight: tx.lastValidBlockHeight!,
      },
      commitment,
    ),
  );

  return sig;
}

function readKp(p: string): Keypair {
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(p).toString()))
  );
}

const WALLETS = [
  os.homedir() + "/.config/solana/devnet.json",
  os.homedir() + "/.config/solana/wallet2.json",
  os.homedir() + "/.config/solana/wallet3.json",
];

const ENCRYPTED_DEFI_ID = new PublicKey("AmzMmGcKUqMWf57WPXhHBkE9QzrbXCc1emFK6hsVJTj7");
const ENCRYPTED_DEFI_IDL_PATH = path.join(
  os.homedir(), "arcium-projects/encrypted_defi/target/idl/encrypted_defi.json"
);
const PRIVATE_VOTING_ID = new PublicKey("S43YKqU6x229PdY5oUssPoD2UgH4EDUvugYos6WxvDY");
const PRIVATE_VOTING_IDL_PATH = path.join(
  os.homedir(), "arcium-projects/private_voting/target/idl/private_voting.json"
);

// encrypted_defi match_order computation
async function runMatchOrderComputation(walletPath: string, clusterOffset: number): Promise<boolean> {
  const walletName = path.basename(walletPath, ".json");
  try {
    const owner = readKp(walletPath);
    const conn = new anchor.web3.Connection(
      process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed"
    );
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(owner), {
      commitment: "confirmed", skipPreflight: true,
    });
    provider.sendAndConfirm = (
      tx: anchor.web3.Transaction,
      signers?: anchor.web3.Signer[],
      opts?: anchor.web3.ConfirmOptions,
    ) => sendAndConfirmCompat(provider, tx, signers || [], opts || {});
    anchor.setProvider(provider);

    const idl = JSON.parse(fs.readFileSync(ENCRYPTED_DEFI_IDL_PATH, "utf-8"));
    const program = new anchor.Program(idl, provider) as Program<any>;

    let mxePublicKey: Uint8Array | null = null;
    for (let i = 0; i < 10; i++) {
      try {
        mxePublicKey = await getMXEPublicKey(provider, ENCRYPTED_DEFI_ID);
        if (mxePublicKey) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!mxePublicKey) {
      log("match_order_mxe_fail", { wallet: walletName });
      return false;
    }

    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    // 랜덤 bid/ask 가격 암호화
    const bid = BigInt(Math.floor(Math.random() * 200) + 100);  // 100~300
    const ask = BigInt(Math.floor(Math.random() * 200) + 50);   // 50~250
    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([bid, ask], nonce);
    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    log("submitting_match_order", {
      wallet: walletName, bid: bid.toString(), ask: ask.toString(), cluster: clusterOffset,
    });

    const queueSig = await program.methods
      .matchOrder(
        computationOffset,
        Array.from(ciphertext[0]),
        Array.from(ciphertext[1]),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString()),
      )
      .accountsPartial({
        computationAccount: getComputationAccAddress(clusterOffset, computationOffset),
        clusterAccount: getClusterAccAddress(clusterOffset),
        mxeAccount: getMXEAccAddress(ENCRYPTED_DEFI_ID),
        mempoolAccount: getMempoolAccAddress(clusterOffset),
        executingPool: getExecutingPoolAccAddress(clusterOffset),
        compDefAccount: getCompDefAccAddress(
          ENCRYPTED_DEFI_ID,
          Buffer.from(getCompDefAccOffset("match_order")).readUInt32LE(),
        ),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    log("match_order_queued", { wallet: walletName, sig: queueSig });

    const finalizeSig = await Promise.race([
      awaitComputationFinalization(provider, computationOffset, ENCRYPTED_DEFI_ID, "confirmed"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 90_000)),
    ]);

    log("match_order_success", { wallet: walletName, queueSig, finalizeSig, clusterOffset });
    return true;
  } catch (e: any) {
    const txLogs: string[] = e?.logs || [];
    const errCode = txLogs.find((l: string) => /custom program error|Error Code|0x/i.test(l)) || '';
    log("match_order_fail", {
      wallet: walletName,
      message: (e?.message || e?.toString?.() || '').slice(0, 300),
      errCode,
      logs: txLogs.slice(0, 5),
    });
    return false;
  }
}

async function runComputation(walletPath: string): Promise<boolean> {
  const walletName = path.basename(walletPath, ".json");

  try {
    const owner = readKp(walletPath);
    log("computation_start", { wallet: walletName, pub: owner.publicKey.toString() });

    const conn = new anchor.web3.Connection(
      process.env.RPC_URL || "https://api.devnet.solana.com",
      "confirmed"
    );
    const wallet = new anchor.Wallet(owner);
    const provider = new anchor.AnchorProvider(conn, wallet, {
      commitment: "confirmed",
      skipPreflight: true,
    });
    provider.sendAndConfirm = (
      tx: anchor.web3.Transaction,
      signers?: anchor.web3.Signer[],
      opts?: anchor.web3.ConfirmOptions,
    ) => sendAndConfirmCompat(provider, tx, signers || [], opts || {});
    anchor.setProvider(provider);

    const idl = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../target/idl/hello_world.json"),
        "utf-8"
      )
    );
    const program = new anchor.Program(idl, provider) as Program<HelloWorld>;
    const arciumEnv = getArciumEnv();
    const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

    log("fetching_mxe_pubkey", { wallet: walletName, cluster: arciumEnv.arciumClusterOffset });

    // MXE 공개키 가져오기 (최대 10회 재시도)
    let mxePublicKey: Uint8Array | null = null;
    for (let i = 0; i < 10; i++) {
      try {
        mxePublicKey = await getMXEPublicKey(provider, program.programId);
        if (mxePublicKey) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!mxePublicKey) {
      log("mxe_pubkey_fail", { wallet: walletName });
      return false;
    }

    // x25519 키 교환 + RescueCipher 암호화
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    // 랜덤 값으로 암호화 (매번 다른 computation)
    const val1 = BigInt(Math.floor(Math.random() * 1000) + 1);
    const val2 = BigInt(Math.floor(Math.random() * 1000) + 1);
    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([val1, val2], nonce);

    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    log("submitting_computation", {
      wallet: walletName,
      val1: val1.toString(),
      val2: val2.toString(),
      expectedSum: (val1 + val2).toString(),
    });

    // add_together instruction 호출 (실제 MXE computation 트리거)
    const queueSig = await program.methods
      .addTogether(
        computationOffset,
        Array.from(ciphertext[0]),
        Array.from(ciphertext[1]),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString()),
      )
      .accountsPartial({
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          computationOffset,
        ),
        clusterAccount,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("add_together")).readUInt32LE(),
        ),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    log("computation_queued", { wallet: walletName, sig: queueSig });

    // MXE 결과 대기 (최대 90초)
    const finalizeSig = await Promise.race([
      awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 90_000)),
    ]);

    log("computation_success", {
      wallet: walletName,
      queueSig,
      finalizeSig,
      clusterOffset: arciumEnv.arciumClusterOffset,
    });

    return true;
  } catch (e: any) {
    // SendTransactionError에서 실제 에러 추출
    const txLogs: string[] = e?.logs || e?.transactionMessage?.compiledMessage?.instructions || [];
    const errCode = txLogs.find((l: string) => /custom program error|Error Code|0x/i.test(l)) || '';
    const errDetail = {
      message: (e?.message || e?.toString?.() || '').slice(0, 300),
      logs: txLogs.slice(0, 8),
      errCode,
      code: e?.code,
      name: e?.name,
      raw: (() => { try { return JSON.stringify(e).slice(0, 200); } catch { return String(e).slice(0, 200); } })(),
    };
    log("computation_fail", { wallet: walletName, ...errDetail });
    return false;
  }
}

// private_voting add_together computation (same circuit, different program = diversification)
async function runPrivateVotingComputation(walletPath: string, clusterOffset: number): Promise<boolean> {
  const walletName = path.basename(walletPath, ".json");
  try {
    const owner = readKp(walletPath);
    const conn = new anchor.web3.Connection(
      process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed"
    );
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(owner), {
      commitment: "confirmed", skipPreflight: true,
    });
    provider.sendAndConfirm = (
      tx: anchor.web3.Transaction,
      signers?: anchor.web3.Signer[],
      opts?: anchor.web3.ConfirmOptions,
    ) => sendAndConfirmCompat(provider, tx, signers || [], opts || {});
    anchor.setProvider(provider);

    const idl = JSON.parse(fs.readFileSync(PRIVATE_VOTING_IDL_PATH, "utf-8"));
    const program = new anchor.Program(idl, provider) as Program<any>;

    let mxePublicKey: Uint8Array | null = null;
    for (let i = 0; i < 8; i++) {
      try {
        mxePublicKey = await getMXEPublicKey(provider, PRIVATE_VOTING_ID);
        if (mxePublicKey) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!mxePublicKey) {
      log("private_voting_mxe_fail", { wallet: walletName });
      return false;
    }

    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    // 투표 값 암호화 (0 또는 1)
    const vote1 = BigInt(Math.floor(Math.random() * 2));
    const vote2 = BigInt(Math.floor(Math.random() * 2));
    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([vote1, vote2], nonce);
    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    log("submitting_private_voting", {
      wallet: walletName, vote1: vote1.toString(), vote2: vote2.toString(), cluster: clusterOffset,
    });

    const queueSig = await program.methods
      .addTogether(
        computationOffset,
        Array.from(ciphertext[0]),
        Array.from(ciphertext[1]),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString()),
      )
      .accountsPartial({
        computationAccount: getComputationAccAddress(clusterOffset, computationOffset),
        clusterAccount: getClusterAccAddress(clusterOffset),
        mxeAccount: getMXEAccAddress(PRIVATE_VOTING_ID),
        mempoolAccount: getMempoolAccAddress(clusterOffset),
        executingPool: getExecutingPoolAccAddress(clusterOffset),
        compDefAccount: getCompDefAccAddress(
          PRIVATE_VOTING_ID,
          Buffer.from(getCompDefAccOffset("add_together")).readUInt32LE(),
        ),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    log("private_voting_queued", { wallet: walletName, sig: queueSig });

    const finalizeSig = await Promise.race([
      awaitComputationFinalization(provider, computationOffset, PRIVATE_VOTING_ID, "confirmed"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 90_000)),
    ]);

    log("private_voting_success", { wallet: walletName, queueSig, finalizeSig, clusterOffset });
    return true;
  } catch (e: any) {
    const txLogs: string[] = e?.logs || [];
    log("private_voting_fail", {
      wallet: walletName,
      message: (e?.message || e?.toString?.() || '').slice(0, 300),
      raw: (() => { try { return JSON.stringify(e).slice(0, 150); } catch { return String(e).slice(0, 150); } })(),
    });
    return false;
  }
}

async function main() {
  log("run_start", { wallets: WALLETS.length });

  const clusters = [456];
  let helloSuccess = false;
  let defiSuccess = false;
  let votingSuccess = false;

  // 실행마다 시작 지갑 로테이션 (round-robin)
  const baseWalletIdx = Math.floor(Date.now() / 1000 / 1200) % WALLETS.length;

  for (const cluster of clusters) {
    process.env.ARCIUM_CLUSTER_OFFSET = String(cluster);

    const tomlPath = path.join(__dirname, "../Arcium.toml");
    const toml = fs.readFileSync(tomlPath, "utf-8");
    fs.writeFileSync(tomlPath, toml.replace(/^offset = .*/m, `offset = ${cluster}`));

    log("trying_cluster", { offset: cluster });

    // 3개 프로그램에 각기 다른 지갑 할당
    const w0 = WALLETS[(baseWalletIdx) % 3];
    const w1 = WALLETS[(baseWalletIdx + 1) % 3];
    const w2 = WALLETS[(baseWalletIdx + 2) % 3];

    // hello_world add_together
    if (!helloSuccess) {
      helloSuccess = await runComputation(w0);
    }

    // encrypted_defi match_order (cluster 456만)
    if (!defiSuccess && cluster === 456) {
      defiSuccess = await runMatchOrderComputation(w1, cluster);
    }

    // private_voting (cluster 456만)
    if (!votingSuccess && cluster === 456) {
      votingSuccess = await runPrivateVotingComputation(w2, cluster);
    }

    if (helloSuccess && defiSuccess && votingSuccess) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  log("run_complete", { helloSuccess, defiSuccess, votingSuccess });
}

main().catch(e => {
  log("fatal", { error: e.message });
  process.exit(1);
});
