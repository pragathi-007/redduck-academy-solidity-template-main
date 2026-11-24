// Signing helper for claimWithSignature. Implement this so the signature it
// produces is accepted by your contract when signed by the `signer` passed to
// the constructor. You choose the signing scheme — it must match what the
// contract recovers and must bind the signature to the specific claimant.

import { encodePacked, keccak256, type Address, type Hex, type WalletClient } from "viem";

export interface ClaimSignatureParts {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

export async function signAirdropClaim(
  signerWallet: WalletClient,
  claimant: Address,
  amount: bigint,
  contractAddress: Address,
): Promise<ClaimSignatureParts> {
  if (!signerWallet.account) {
    throw new Error("Signer wallet has no account");
  }

  const digest = keccak256(
    encodePacked(["address", "uint256", "address"], [claimant, amount, contractAddress]),
  );

  const signature = await signerWallet.signMessage({
    account: signerWallet.account,
    message: { raw: digest },
  });

  if (signature.length !== 132) {
    throw new Error("Invalid signature length");
  }

  const r = signature.slice(0, 66) as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = Number.parseInt(signature.slice(130, 132), 16);

  return { v, r, s };
}
