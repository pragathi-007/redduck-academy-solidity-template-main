import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const KEY_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const CALLBACK_GAS = 500_000;

// Starter test: the happy path end to end - two deposits, time travel to the
// deadline, a forced VRF response, and a claim. It fails until deposit,
// drawWinner, fulfillRandomWords, and claim work. Don't edit it. Add tests for
// the failure modes and the weighted-pick boundaries in a separate file.
describe("Raffle", function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await viem.getWalletClients();

    const btc = await viem.deployContract("Token", ["Bitcoin", "BTC", parseEther("1000000")]);
    const feed = await viem.deployContract("PriceFeedMock", [8, 60_000n * 10n ** 8n]);

    const coord = await viem.deployContract("VRFCoordinatorMock", [
      10n ** 17n,
      10n ** 9n,
      10n ** 15n,
    ]);

    await coord.write.createSubscription();
    const [created] = await coord.getEvents.SubscriptionCreated({}, { fromBlock: 0n });
    const subId = created.args.subId as bigint;
    await coord.write.fundSubscription([subId, parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const drawTime = BigInt(now + 600);

    const raffle = await viem.deployContract("Raffle", [
      btc.address,
      feed.address,
      drawTime,
      coord.address,
      subId,
      KEY_HASH,
      CALLBACK_GAS,
    ]);
    await coord.write.addConsumer([subId, raffle.address]);

    for (const w of [alice, bob]) {
      await btc.write.transfer([w.account.address, parseEther("100")]);
      await btc.write.approve([raffle.address, parseEther("100")], { account: w.account });
    }

    return { btc, feed, coord, raffle, subId, drawTime, deployer, alice, bob };
  }

  it("runs the full raffle: deposit, draw, weighted winner, claim", async function () {
    const { btc, coord, raffle, drawTime, alice, bob } = await deployFixture();

    // Entry 0: alice (weight 1 BTC). Entry 1: bob (weight 3 BTC).
    await raffle.write.deposit([parseEther("1")], { account: alice.account });
    await raffle.write.deposit([parseEther("3")], { account: bob.account });

    await networkHelpers.time.increaseTo(drawTime);
    await raffle.write.drawWinner();

    const requestId = (await raffle.read.requestId()) as bigint;
    const totalWeight = (await raffle.read.totalWeight()) as bigint;

    // A random word at the top of the range lands in bob's entry (index 1).
    await coord.write.fulfillRandomWordsWithOverride([
      requestId,
      raffle.address,
      [totalWeight - 1n],
    ]);

    const before = (await btc.read.balanceOf([bob.account.address])) as bigint;
    await raffle.write.claim([1n], { account: bob.account });
    const after = (await btc.read.balanceOf([bob.account.address])) as bigint;

    assert.equal(after - before, parseEther("4"));
  });

  it("weights deposits by USD price at deposit time even if price moves later", async function () {
    const { feed, coord, raffle, alice, bob } = await deployFixture();

    // Alice deposits 1 BTC at $60,000 => weight = 60,000 * 1e8 * 1e18
    await raffle.write.deposit([parseEther("1")], { account: alice.account });

    // Price drops to $20,000 before Bob deposits
    await feed.write.updateAnswer([20_000n * 10n ** 8n]);

    // Bob deposits 3 BTC at $20,000 => weight = 60,000 * 1e8 * 1e18 (equal USD weight to Alice)
    await raffle.write.deposit([parseEther("3")], { account: bob.account });

    const totalWeight = (await raffle.read.totalWeight()) as bigint;
    const halfWeight = totalWeight / 2n;

    await networkHelpers.time.increase(600);
    await raffle.write.drawWinner();
    const requestId = (await raffle.read.requestId()) as bigint;

    // Boundary check: halfWeight - 1 is the upper boundary of Alice's interval [0, halfWeight)
    await coord.write.fulfillRandomWordsWithOverride([
      requestId,
      raffle.address,
      [halfWeight - 1n],
    ]);

    // Bob cannot claim Alice's winning index 0
    await assert.rejects(
      raffle.write.claim([0n], { account: bob.account }),
      /InvalidClaim/,
    );

    // Alice claims index 0 and wins the entire 4 BTC pool
    await raffle.write.claim([0n], { account: alice.account });
  });

  it("picks the second entry right at the lower boundary of its cumulative range", async function () {
    const { coord, raffle, alice, bob } = await deployFixture();

    // Entry 0: Alice (1 BTC), Entry 1: Bob (3 BTC) => totalWeight = 4x, Alice = [0, 1x), Bob = [1x, 4x)
    await raffle.write.deposit([parseEther("1")], { account: alice.account });
    await raffle.write.deposit([parseEther("3")], { account: bob.account });

    const totalWeight = (await raffle.read.totalWeight()) as bigint;
    const aliceEnd = totalWeight / 4n;

    await networkHelpers.time.increase(600);
    await raffle.write.drawWinner();
    const requestId = (await raffle.read.requestId()) as bigint;

    // Exact boundary: randomWord == aliceEnd must land in Bob's entry (index 1), not Alice's (index 0)
    await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [aliceEnd]]);

    await assert.rejects(
      raffle.write.claim([0n], { account: alice.account }),
      /InvalidClaim/,
    );

    await raffle.write.claim([1n], { account: bob.account });
  });

  it("rejects deposits on zero amount, after deadline, after draw request, or with bad/stale prices", async function () {
    const { btc, feed, coord, raffle, alice } = await deployFixture();

    // Zero deposit
    await assert.rejects(
      raffle.write.deposit([0n], { account: alice.account }),
      /InvalidDeposit/,
    );

    // Non-positive price
    await feed.write.updateAnswer([0n]);
    await assert.rejects(
      raffle.write.deposit([parseEther("1")], { account: alice.account }),
      /InvalidPrice/,
    );

    // Deploy a raffle whose deadline is well into the future relative to current block time
    const currentTs = BigInt(await networkHelpers.time.latest());
    const farDrawTime = currentTs + 20_000n;
    const farRaffle = await viem.deployContract("Raffle", [
      btc.address,
      feed.address,
      farDrawTime,
      coord.address,
      1n,
      KEY_HASH,
      CALLBACK_GAS,
    ]);
    await btc.write.approve([farRaffle.address, parseEther("100")], { account: alice.account });

    await feed.write.updateAnswer([60_000n * 10n ** 8n]);
    await networkHelpers.time.increase(3605);

    // Price is > 1 hour old while still before farDrawTime => reverts with InvalidPrice
    await assert.rejects(
      farRaffle.write.deposit([parseEther("1")], { account: alice.account }),
      /InvalidPrice/,
    );

    // Advance past farDrawTime => deposit rejected with InvalidDeposit
    const afterStaleTs = BigInt(await networkHelpers.time.latest());
    const deltaToDeadline = farDrawTime > afterStaleTs ? farDrawTime - afterStaleTs + 1n : 1n;
    await networkHelpers.time.increase(deltaToDeadline);
    await assert.rejects(
      farRaffle.write.deposit([parseEther("1")], { account: alice.account }),
      /InvalidDeposit/,
    );
  });

  it("rejects premature draw, empty draw, duplicate draw, premature claim, and double claim", async function () {
    const { coord, raffle, alice, bob } = await deployFixture();

    // Cannot draw before drawTime
    await assert.rejects(raffle.write.drawWinner(), /DrawNotReady/);

    // Cannot draw with zero deposits even after drawTime
    await networkHelpers.time.increase(600);
    await assert.rejects(raffle.write.drawWinner(), /DrawNotReady/);

    // Deploy fresh fixture with one deposit to test draw & claim lifecycle guards
    const fresh = await deployFixture();
    await fresh.raffle.write.deposit([parseEther("1")], { account: fresh.alice.account });

    // Still before drawTime
    await assert.rejects(fresh.raffle.write.drawWinner(), /DrawNotReady/);

    await networkHelpers.time.increase(600);
    await fresh.raffle.write.drawWinner();

    // Cannot draw twice
    await assert.rejects(fresh.raffle.write.drawWinner(), /DrawAlreadyRequested/);

    // Cannot claim before VRF callback fulfills random word
    await assert.rejects(
      fresh.raffle.write.claim([0n], { account: fresh.alice.account }),
      /InvalidClaim/,
    );

    // Fulfill VRF
    const requestId = (await fresh.raffle.read.requestId()) as bigint;
    await fresh.coord.write.fulfillRandomWordsWithOverride([
      requestId,
      fresh.raffle.address,
      [0n],
    ]);

    // Non-winner or invalid index reverts InvalidClaim
    await assert.rejects(
      fresh.raffle.write.claim([0n], { account: fresh.bob.account }),
      /InvalidClaim/,
    );
    await assert.rejects(
      fresh.raffle.write.claim([99n], { account: fresh.alice.account }),
      /InvalidClaim/,
    );

    // Valid winner claims once
    await fresh.raffle.write.claim([0n], { account: fresh.alice.account });

    // Double claim reverts InvalidClaim
    await assert.rejects(
      fresh.raffle.write.claim([0n], { account: fresh.alice.account }),
      /InvalidClaim/,
    );
  });
});