import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  getMXEAccAddress,
  getLookupTableAddress,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";

async function main() {
  process.env.ARCIUM_CLUSTER_OFFSET = "456";

  const conn = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/devnet.json`).toString()))
  );
  const wallet = new anchor.Wallet(owner);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
    skipPreflight: true,
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync("target/idl/hello_world.json", "utf-8"));
  const program = new anchor.Program(idl, provider) as Program<any>;
  const arciumProgram = getArciumProgram(provider);

  console.log("Program ID:", program.programId.toString());

  const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("add_together");

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];

  console.log("Comp def PDA:", compDefPDA.toString());

  const mxeAccount = getMXEAccAddress(program.programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);

  try {
    const sig = await program.methods
      .initAddTogetherCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log("init_add_together_comp_def sig:", sig);
  } catch (e: any) {
    console.log("Comp def already exists or error:", e.message || String(e));
  }

  console.log("Uploading circuit...");
  const rawCircuit = fs.readFileSync("build/add_together.arcis");
  await uploadCircuit(
    provider,
    "add_together",
    program.programId,
    rawCircuit,
    true,
    500,
    { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" },
  );
  console.log("Circuit uploaded!");
}

main().catch(e => {
  console.error("Fatal:", e.message || String(e));
  process.exit(1);
});
