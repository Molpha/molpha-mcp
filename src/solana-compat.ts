import { isSignerRole, isWritableRole, type Address, type Instruction } from "@solana/kit";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * Isolated legacy-interop boundary: @molpha/sdk, @turnkey/solana, and
 * connection.sendRawTransaction/confirmTransaction still require classic web3.js
 * types. Everything else in this codebase works in terms of @solana/kit's
 * `Address`/`Instruction`.
 */
export function toLegacyPublicKey(address: Address): PublicKey {
  return new PublicKey(address);
}

export function toLegacyInstruction(instruction: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: toLegacyPublicKey(instruction.programAddress),
    keys: (instruction.accounts ?? []).map((account) => ({
      pubkey: toLegacyPublicKey(account.address),
      isSigner: isSignerRole(account.role),
      isWritable: isWritableRole(account.role)
    })),
    data: Buffer.from(instruction.data ?? new Uint8Array())
  });
}
