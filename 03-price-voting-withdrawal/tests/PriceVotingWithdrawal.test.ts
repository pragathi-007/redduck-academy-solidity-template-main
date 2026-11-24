
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

describe("PriceVotingWithdrawal", function () {

  async function deployFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", [
      "Vote Token",
      "VOTE",
      parseEther("1000000")
    ]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract(
      "PriceVotingWithdrawal",
      [token.address, votingEnd]
    );

    for (const w of [alice, bob, carol]) {
      await token.write.transfer([
        w.account.address,
        parseEther("1000")
      ]);

      await token.write.approve(
        [voting.address, parseEther("1000")],
        { account: w.account }
      );
    }

    return { token, voting, votingEnd, deployer, alice, bob, carol };
  }

  it("deploys", async function () {
    await networkHelpers.loadFixture(deployFixture);
  });

  it("allows a user to vote", async function () {
    const { voting, alice } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = parseEther("100");
    const price = 100n;

    await voting.write.vote([price, amount], {
      account: alice.account
    });

    assert.equal(
      await voting.read.lockedBalance([
        alice.account.address,
        price
      ]),
      amount
    );

    assert.equal(
      await voting.read.totalWeightAtPrice([price]),
      amount
    );
  });

  it("allows multiple users to vote for the same price", async function () {
    const { voting, alice, bob } =
      await networkHelpers.loadFixture(deployFixture);

    const price = 100n;

    await voting.write.vote(
      [price, parseEther("100")],
      { account: alice.account }
    );

    await voting.write.vote(
      [price, parseEther("50")],
      { account: bob.account }
    );

    assert.equal(
      await voting.read.totalWeightAtPrice([price]),
      parseEther("150")
    );
  });

  it("allows withdrawal during voting", async function () {
    const { token, voting, alice } =
      await networkHelpers.loadFixture(deployFixture);

    const price = 100n;
    const amount = parseEther("100");
    const withdrawal = parseEther("40");

    const balanceBefore = await token.read.balanceOf([
      alice.account.address
    ]);

    await voting.write.vote([price, amount], {
      account: alice.account
    });

    await voting.write.withdraw([price, withdrawal], {
      account: alice.account
    });

    assert.equal(
      await voting.read.lockedBalance([
        alice.account.address,
        price
      ]),
      parseEther("60")
    );

    assert.equal(
      await voting.read.totalWeightAtPrice([price]),
      parseEther("60")
    );

    assert.equal(
      await token.read.balanceOf([alice.account.address]),
      balanceBefore - amount + withdrawal
    );
  });

  it("rejects withdrawal of more tokens than locked", async function () {
    const { voting, alice } =
      await networkHelpers.loadFixture(deployFixture);

    await voting.write.vote(
      [100n, parseEther("50")],
      { account: alice.account }
    );

    await assert.rejects(async () => {
      await voting.write.withdraw(
        [100n, parseEther("100")],
        { account: alice.account }
      );
    });
  });

  it("rejects zero amount voting", async function () {
    const { voting, alice } =
      await networkHelpers.loadFixture(deployFixture);

    await assert.rejects(async () => {
      await voting.write.vote([100n, 0n], {
        account: alice.account
      });
    });
  });

  it("rejects voting after the voting period ends", async function () {
    const { voting, alice } =
      await networkHelpers.loadFixture(deployFixture);

    await networkHelpers.time.increase(ONE_DAY + 1);

    await assert.rejects(async () => {
      await voting.write.vote(
        [100n, parseEther("50")],
        { account: alice.account }
      );
    });
  });

  it("does not allow reading the winning price before voting ends", async function () {
    const { voting } =
      await networkHelpers.loadFixture(deployFixture);

    await assert.rejects(async () => {
      await voting.read.winningPrice();
    });
  });

  it("returns the correct winning price after withdrawals", async function () {
    const { voting, alice, bob, carol } =
      await networkHelpers.loadFixture(deployFixture);

    await voting.write.vote(
      [100n, parseEther("50")],
      { account: alice.account }
    );

    await voting.write.vote(
      [100n, parseEther("30")],
      { account: bob.account }
    );

    await voting.write.vote(
      [200n, parseEther("60")],
      { account: carol.account }
    );

    // Alice withdraws her 50 tokens.
    await voting.write.withdraw(
      [100n, parseEther("50")],
      { account: alice.account }
    );

    await networkHelpers.time.increase(ONE_DAY + 1);

    assert.equal(
      await voting.read.winningPrice(),
      200n
    );
  });

  it("rejects winning price when there are no remaining votes", async function () {
    const { voting, alice } =
      await networkHelpers.loadFixture(deployFixture);

    await voting.write.vote(
      [100n, parseEther("50")],
      { account: alice.account }
    );

    await voting.write.withdraw(
      [100n, parseEther("50")],
      { account: alice.account }
    );

    await networkHelpers.time.increase(ONE_DAY + 1);

    await assert.rejects(async () => {
      await voting.read.winningPrice();
    });
  });

});
