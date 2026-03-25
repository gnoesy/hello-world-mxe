import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { uploadCircuit } from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";

async function main() {
  process.env.ARCIUM_CLUSTER_OFFSET = "456";
  const conn = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/devnet.json`).toString()))
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(owner), {
    commitment: "confirmed", skipPreflight: true,
  });
  const idl = JSON.parse(fs.readFileSync("target/idl/hello_world.json", "utf-8"));
  const program = new anchor.Program(idl, provider) as anchor.Program<any>;

  console.log("Uploading add_together circuit to cluster 456...");
  const rawCircuit = fs.readFileSync("build/add_together.arcis");
  await uploadCircuit(provider, "add_together", program.programId, rawCircuit, true, 500,
    { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" });
  console.log("Circuit uploaded!");
}

main().catch(e => { console.error("Error:", e.message || String(e)); process.exit(1); });
