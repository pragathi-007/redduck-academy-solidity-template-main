import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, getAddress } from "viem";
import { MerkleTree, type AirdropEntry } from "./merkle.ts";
import { signAirdropClaim } from "./signatures.ts";

const { viem } = await network.connect();

// Two starter happy-path tests: one claim via the Merkle proof, one via an admin
// signature. Both fail until the contract and the matching off-chain code
// (merkle.ts, signatures.ts) are implemented. Add tests for the failure modes
// described in TASK.md (bad proofs, wrong signer/amount/recipient, replay across
// both paths via the shared hasClaimed).
describe("MerkleAirdrop", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol, signer, dave, eve] = await viem.getWalletClients();

    const entries: AirdropEntry[] = [
      { account: getAddress(alice.account.address), amount: parseEther("100") },
      { account: getAddress(bob.account.address), amount: parseEther("200") },
      { account: getAddress(carol.account.address), amount: parseEther("300") },
      { account: getAddress(eve.account.address), amount: parseEther("50") },
    ];
    const tree = new MerkleTree(entries);

    const token = await viem.deployContract("Token", [
      "Redduck Token",
      "RDDK",
      parseEther("100000000000000"),
    ]);
    const airdrop = await viem.deployContract("MerkleAirdrop", [
      token.address,
      tree.root,
      signer.account.address,
    ]);

    await token.write.transfer([airdrop.address, parseEther("100000000000000")], {
      account: deployer.account,
    });

    return { entries, tree, token, airdrop, deployer, alice, bob, carol, signer, dave, eve };
  }

  it("lets an eligible account claim its allocation with a Merkle proof", async function () {
    const { entries, tree, token, airdrop, alice } = await deployFixture();

    const proof = tree.getProof(0);
    const { account, amount } = entries[0];

    await airdrop.write.claim([amount, proof], { account: alice.account });

    assert.equal((await token.read.balanceOf([account])) as bigint, amount);
    assert.equal((await airdrop.read.hasClaimed([account])) as boolean, true);
  });

  it("lets an authorized account claim with an admin signature (not on the Merkle list)", async function () {
    const { token, airdrop, signer, dave } = await deployFixture();

    const daveAddr = getAddress(dave.account.address);
    const amount = parseEther("50");

    const { v, r, s } = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);

    await airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account });

    assert.equal((await token.read.balanceOf([daveAddr])) as bigint, amount);
    assert.equal((await airdrop.read.hasClaimed([daveAddr])) as boolean, true);
  });

  it("rejects an invalid Merkle proof", async function () {
    const { airdrop, alice } = await deployFixture();

    await assert.rejects(
      airdrop.write.claim([parseEther("100"), []], { account: alice.account }),
      /InvalidProof/,
    );
  });

  it("rejects a signature from the wrong signer", async function () {
    const { airdrop, deployer, dave } = await deployFixture();
    const amount = parseEther("50");
    const daveAddr = getAddress(dave.account.address);
    const { v, r, s } = await signAirdropClaim(deployer, daveAddr, amount, airdrop.address);

    await assert.rejects(
      airdrop.write.claimWithSignature([amount, v, r, s], {
        account: dave.account,
      }),
      /InvalidSignature/,
    );
  });

  it("rejects a signature used for the wrong recipient or amount", async function () {
    const { airdrop, signer, dave, eve } = await deployFixture();
    const amount = parseEther("50");
    const daveAddr = getAddress(dave.account.address);
    const eveAddr = getAddress(eve.account.address);

    const daveSignature = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);

    await assert.rejects(
      airdrop.write.claimWithSignature(
        [amount, daveSignature.v, daveSignature.r, daveSignature.s],
        { account: eve.account },
      ),
      /InvalidSignature/,
    );

    await assert.rejects(
      airdrop.write.claimWithSignature(
        [amount + 1n, daveSignature.v, daveSignature.r, daveSignature.s],
        { account: dave.account },
      ),
      /InvalidSignature/,
    );

    assert.equal((await airdrop.read.hasClaimed([eveAddr])) as boolean, false);
  });

  it("binds a signature to the deployed airdrop contract", async function () {
    const { airdrop, tree, signer, dave, deployer } = await deployFixture();
    const amount = parseEther("50");
    const daveAddr = getAddress(dave.account.address);

    const secondToken = await viem.deployContract("Token", [
      "Second Redduck Token",
      "SRDDK",
      parseEther("1000000"),
    ]);
    const secondAirdrop = await viem.deployContract("MerkleAirdrop", [
      secondToken.address,
      tree.root,
      signer.account.address,
    ]);
    await secondToken.write.transfer([secondAirdrop.address, parseEther("1000000")], {
      account: deployer.account,
    });

    const signature = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);

    await assert.rejects(
      secondAirdrop.write.claimWithSignature([amount, signature.v, signature.r, signature.s], {
        account: dave.account,
      }),
      /InvalidSignature/,
    );
  });

  it("shares the claimed state between both claim paths", async function () {
    const { entries, tree, airdrop, signer, alice } = await deployFixture();
    const { account, amount } = entries[0];
    const proof = tree.getProof(0);

    await airdrop.write.claim([amount, proof], { account: alice.account });

    const signature = await signAirdropClaim(signer, account, amount, airdrop.address);

    await assert.rejects(
      airdrop.write.claimWithSignature([amount, signature.v, signature.r, signature.s], {
        account: alice.account,
      }),
      /AlreadyClaimed/,
    );

    await assert.rejects(
      airdrop.write.claim([amount, proof], { account: alice.account }),
      /AlreadyClaimed/,
    );
  });
});
