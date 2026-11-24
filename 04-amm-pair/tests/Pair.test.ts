import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther } from "viem";

const { viem } = await network.connect();

// Starter test: one swap end-to-end. It fails until addLiquidity, swap, and
// getAmountOut are implemented. Don't edit it. Add the remaining behaviors
// (liquidity provision and removal, slippage and invalid-token rejection, the
// first-depositor lock, and edge cases) in a separate test file.
describe("Pair (pull-based AMM)", function () {
  async function deployFixture() {
    const [deployer, alice] = await viem.getWalletClients();

    const tokenA = await viem.deployContract("Token", ["Token A", "AAA", parseEther("1000000")]);
    const tokenB = await viem.deployContract("Token", ["Token B", "BBB", parseEther("1000000")]);

    const pair = await viem.deployContract("Pair", [tokenA.address, tokenB.address]);

    await tokenA.write.transfer([alice.account.address, parseEther("100000")]);
    await tokenB.write.transfer([alice.account.address, parseEther("100000")]);

    for (const w of [deployer, alice]) {
      await tokenA.write.approve([pair.address, parseEther("1000000")], { account: w.account });
      await tokenB.write.approve([pair.address, parseEther("1000000")], { account: w.account });
    }

    return { pair, tokenA, tokenB, deployer, alice };
  }

  it("swap charges the 0.3% fee, moves the price, and does not let k decrease", async function () {
    const { pair, tokenA, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

    const r0Before = (await pair.read.reserve0()) as bigint;
    const r1Before = (await pair.read.reserve1()) as bigint;
    const kBefore = r0Before * r1Before;

    const amountIn = parseEther("100");
    const expectedOut = (await pair.read.getAmountOut([amountIn, r0Before, r1Before])) as bigint;

    await pair.write.swap([tokenA.address, amountIn, 0n], { account: alice.account });

    const r0After = (await pair.read.reserve0()) as bigint;
    const r1After = (await pair.read.reserve1()) as bigint;

    assert.equal(r0After, r0Before + amountIn);
    assert.equal(r1After, r1Before - expectedOut);
    assert.ok(
      expectedOut > parseEther("90") && expectedOut < parseEther("91"),
      `got ${expectedOut}`,
    );
    assert.ok(r0After * r1After > kBefore, "k must not decrease across a swap");
  });

  it("locks MINIMUM_LIQUIDITY on first deposit and mints proportional LP on balanced later deposits", async function () {
    const { pair, deployer, alice } = await deployFixture();
    const deadAddress = "0x000000000000000000000000000000000000dEaD";

    const minLiquidity = (await pair.read.MINIMUM_LIQUIDITY()) as bigint;
    assert.ok(minLiquidity > 0n);

    await pair.write.addLiquidity([parseEther("100"), parseEther("400")]);

    const deployerLpAfterFirst = (await pair.read.balanceOf([deployer.account.address])) as bigint;
    const totalSupplyAfterFirst = (await pair.read.totalSupply()) as bigint;
    const lockedLp = (await pair.read.balanceOf([deadAddress])) as bigint;

    assert.equal(totalSupplyAfterFirst, parseEther("200"));
    assert.equal(lockedLp, minLiquidity);
    assert.equal(deployerLpAfterFirst, parseEther("200") - minLiquidity);

    // Balanced 1:4 follow-up deposit doubles the pool reserves and mints 200 LP
    await pair.write.addLiquidity([parseEther("100"), parseEther("400")], {
      account: alice.account,
    });

    const aliceLp = (await pair.read.balanceOf([alice.account.address])) as bigint;
    assert.equal(aliceLp, parseEther("200"));
    assert.equal(await pair.read.totalSupply(), parseEther("400"));
    assert.equal(await pair.read.reserve0(), parseEther("200"));
    assert.equal(await pair.read.reserve1(), parseEther("800"));
  });

  it("swaps in the reverse tokenB-to-tokenA direction with 0.3% fee", async function () {
    const { pair, tokenA, tokenB, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

    const r0Before = (await pair.read.reserve0()) as bigint;
    const r1Before = (await pair.read.reserve1()) as bigint;
    const kBefore = r0Before * r1Before;

    const aliceTokenABefore = (await tokenA.read.balanceOf([alice.account.address])) as bigint;
    const amountIn = parseEther("100");
    const expectedOut = (await pair.read.getAmountOut([amountIn, r1Before, r0Before])) as bigint;

    await pair.write.swap([tokenB.address, amountIn, expectedOut], { account: alice.account });

    const r0After = (await pair.read.reserve0()) as bigint;
    const r1After = (await pair.read.reserve1()) as bigint;
    const aliceTokenAAfter = (await tokenA.read.balanceOf([alice.account.address])) as bigint;

    assert.equal(r1After, r1Before + amountIn);
    assert.equal(r0After, r0Before - expectedOut);
    assert.equal(aliceTokenAAfter - aliceTokenABefore, expectedOut);
    assert.ok(r0After * r1After > kBefore, "k must not decrease across a reverse swap");
  });

  it("removes liquidity proportionally and updates reserves and LP supply", async function () {
    const { pair, tokenA, tokenB, deployer } = await deployFixture();

    await pair.write.addLiquidity([parseEther("1000"), parseEther("2000")]);

    const totalSupplyBefore = (await pair.read.totalSupply()) as bigint;
    const deployerLpBefore = (await pair.read.balanceOf([deployer.account.address])) as bigint;
    const halfLp = deployerLpBefore / 2n;

    const aBefore = (await tokenA.read.balanceOf([deployer.account.address])) as bigint;
    const bBefore = (await tokenB.read.balanceOf([deployer.account.address])) as bigint;

    await pair.write.removeLiquidity([halfLp]);

    const expectedA = (halfLp * parseEther("1000")) / totalSupplyBefore;
    const expectedB = (halfLp * parseEther("2000")) / totalSupplyBefore;

    const aAfter = (await tokenA.read.balanceOf([deployer.account.address])) as bigint;
    const bAfter = (await tokenB.read.balanceOf([deployer.account.address])) as bigint;

    assert.equal(aAfter - aBefore, expectedA);
    assert.equal(bAfter - bBefore, expectedB);
    assert.equal(await pair.read.balanceOf([deployer.account.address]), deployerLpBefore - halfLp);
    assert.equal(await pair.read.reserve0(), parseEther("1000") - expectedA);
    assert.equal(await pair.read.reserve1(), parseEther("2000") - expectedB);
  });

  it("rejects zero amounts, zero liquidity, invalid tokens, and excessive slippage", async function () {
    const { pair, tokenA, alice } = await deployFixture();

    await assert.rejects(
      pair.read.getAmountOut([0n, parseEther("100"), parseEther("100")]),
      /InsufficientAmount/,
    );
    await assert.rejects(
      pair.read.getAmountOut([parseEther("10"), 0n, parseEther("100")]),
      /InsufficientLiquidity/,
    );
    await assert.rejects(
      pair.read.getAmountOut([parseEther("10"), parseEther("100"), 0n]),
      /InsufficientLiquidity/,
    );
await assert.rejects(
      pair.write.addLiquidity([0n, parseEther("100")]),
      /InsufficientAmount/,
    );
    await assert.rejects(
      pair.write.addLiquidity([parseEther("100"), 0n]),
      /InsufficientAmount/,
    );

    await assert.rejects(pair.write.removeLiquidity([0n]), /InsufficientAmount/);

    await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);
    const fakeToken = await viem.deployContract("Token", ["Fake", "FAKE", parseEther("1000")]);
    await fakeToken.write.transfer([alice.account.address, parseEther("100")]);
    await fakeToken.write.approve([pair.address, parseEther("100")], { account: alice.account });

    await assert.rejects(
      pair.write.swap([fakeToken.address, parseEther("10"), 0n], { account: alice.account }),
      /InvalidToken/,
    );

    const r0 = (await pair.read.reserve0()) as bigint;
    const r1 = (await pair.read.reserve1()) as bigint;
    const expectedOut = (await pair.read.getAmountOut([parseEther("10"), r0, r1])) as bigint;

    await assert.rejects(
      pair.write.swap([tokenA.address, parseEther("10"), expectedOut + 1n], {
        account: alice.account,
      }),
      /InsufficientOutput/,
    );
  });
});