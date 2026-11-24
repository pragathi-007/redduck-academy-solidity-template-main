import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

// Starter tests: These two show the deploy/vote pattern and pass once the
// contract is implemented. Add the rest of the scenarios listed in TASK.md
// (weight stacking, leader updates, ties, the finalize/claim rules, and the
// revert cases) in this file.
describe("PriceVoting", function () {
  async function deployVotingFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", ["Vote Token", "VOTE", parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVoting", [token.address, votingEnd]);

    // give voters some tokens and approve the voting contract
    for (const w of [alice, bob, carol]) {
      await token.write.transfer([w.account.address, parseEther("1000")]);
      await token.write.approve([voting.address, parseEther("1000")], { account: w.account });
    }

    return { token, voting, votingEnd, deployer, alice, bob, carol };
  }

  describe("vote", function () {
    it("records a single vote", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
    });

    it("emits Voted", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await viem.assertions.emitWithArgs(
        voting.write.vote([100n, parseEther("50")], { account: alice.account }),
        voting,
        "Voted",
        [getAddress(alice.account.address), 100n, parseEther("50")],
      );
    });

    it("stacks weight when two voters vote for the same price and tracks leader", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([150n, parseEther("40")], { account: alice.account });
      await voting.write.vote([150n, parseEther("60")], { account: bob.account });

      assert.equal(await voting.read.weightOf([150n]), parseEther("100"));
      const [leaderPrice, leaderWeight] = (await voting.read.leader()) as [bigint, bigint];
      assert.equal(leaderPrice, 150n);
      assert.equal(leaderWeight, parseEther("100"));
    });

    it("handles two voters voting for different prices and updates leader only when surpassed", async function () {
      const { voting, alice, bob, carol } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("80")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      let [leaderPrice, leaderWeight] = (await voting.read.leader()) as [bigint, bigint];
      assert.equal(leaderPrice, 100n);
      assert.equal(leaderWeight, parseEther("80"));

      // Tie at 80: leader stays at 100n
      await voting.write.vote([200n, parseEther("30")], { account: carol.account });
      [leaderPrice, leaderWeight] = (await voting.read.leader()) as [bigint, bigint];
      assert.equal(leaderPrice, 100n);
      assert.equal(leaderWeight, parseEther("80"));

      // Surpassing 80 updates leader to 200n
      await voting.write.vote([200n, parseEther("10")], { account: bob.account });
      [leaderPrice, leaderWeight] = (await voting.read.leader()) as [bigint, bigint];
      assert.equal(leaderPrice, 200n);
      assert.equal(leaderWeight, parseEther("90"));
    });

    it("lets a single voter vote multiple times across different prices and tracks locked balance", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("25")], { account: alice.account });
      await voting.write.vote([250n, parseEther("75")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("25"));
      assert.equal(await voting.read.weightOf([250n]), parseEther("75"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("100"));
    });

    it("reverts when called after votingEnd, with zero amount, or without sufficient allowance", async function () {
      const { token, voting, votingEnd, alice, bob } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await assert.rejects(
        voting.write.vote([100n, 0n], { account: alice.account }),
        /ZeroAmount/,
      );

      await token.write.approve([voting.address, 0n], { account: bob.account });
      await assert.rejects(voting.write.vote([100n, parseEther("10")], { account: bob.account }));

      await networkHelpers.time.increaseTo(votingEnd);
      await assert.rejects(
        voting.write.vote([100n, parseEther("10")], { account: alice.account }),
        /VotingEnded/,
      );
    });
  });

  describe("finalize", function () {
    it("reverts before votingEnd and reverts if called twice", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await assert.rejects(voting.write.finalize(), /VotingActive/);

      await voting.write.vote([300n, parseEther("50")], { account: alice.account });
      await networkHelpers.time.increaseTo(votingEnd);

      await voting.write.finalize();
      await assert.rejects(voting.write.finalize(), /AlreadyFinalized/);
    });

    it("sets currentTokenPrice and finalized and emits PriceFinalized when a clear winner exists", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([300n, parseEther("120")], { account: alice.account });
      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.finalize(),
        voting,
        "PriceFinalized",
        [300n, parseEther("120")],
      );

      assert.equal(await voting.read.currentTokenPrice(), 300n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("leaves currentTokenPrice at 0 when finalized with no votes or with a tie", async function () {
      const { voting, votingEnd, alice, bob } =
        await networkHelpers.loadFixture(deployVotingFixture);

      // No votes case
      const snap = await networkHelpers.takeSnapshot();
      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();
      assert.equal(await voting.read.currentTokenPrice(), 0n);
      assert.equal(await voting.read.finalized(), true);

      // Tie case
      await snap.restore();
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });
      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();
      assert.equal(await voting.read.currentTokenPrice(), 0n);
      assert.equal(await voting.read.finalized(), true);
    });
  });

  describe("claim", function () {
    it("reverts before votingEnd and reverts when caller has nothing locked", async function () {
      const { voting, votingEnd, alice, bob } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await assert.rejects(voting.write.claim({ account: alice.account }), /VotingActive/);

      await networkHelpers.time.increaseTo(votingEnd);
      await assert.rejects(voting.write.claim({ account: bob.account }), /NothingToClaim/);
    });

    it("returns locked tokens, zeros locked balance, emits Claimed, and prevents claiming twice", async function () {
      const { token, voting, votingEnd, alice } =
        await networkHelpers.loadFixture(deployVotingFixture);

      const lockedAmount = parseEther("75");
      await voting.write.vote([100n, lockedAmount], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd);

      const balanceBefore = (await token.read.balanceOf([alice.account.address])) as bigint;

      await viem.assertions.emitWithArgs(
        voting.write.claim({ account: alice.account }),
        voting,
        "Claimed",
        [getAddress(alice.account.address), lockedAmount],
      );

      const balanceAfter = (await token.read.balanceOf([alice.account.address])) as bigint;
      assert.equal(balanceAfter - balanceBefore, lockedAmount);
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);

      await assert.rejects(voting.write.claim({ account: alice.account }), /NothingToClaim/);
    });
  });
});