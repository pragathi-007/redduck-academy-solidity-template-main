import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther } from "viem";

const { viem } = await network.connect();

describe("Pair (comprehensive behaviors & edge cases)", function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await viem.getWalletClients();

    const tokenA = await viem.deployContract("Token", ["Token A", "AAA", parseEther("1000000")]);
    const tokenB = await viem.deployContract("Token", ["Token B", "BBB", parseEther("1000000")]);
    const tokenC = await viem.deployContract("Token", ["Token C", "CCC", parseEther("1000000")]);

    const pair = await viem.deployContract("Pair", [tokenA.address, tokenB.address]);

    for (const w of [alice, bob]) {
      await tokenA.write.transfer([w.account.address, parseEther("100000")]);
      await tokenB.write.transfer([w.account.address, parseEther("100000")]);
    }

    for (const w of [deployer, alice, bob]) {
      await tokenA.write.approve([pair.address, parseEther("1000000")], { account: w.account });
      await tokenB.write.approve([pair.address, parseEther("1000000")], { account: w.account });
    }

    return { pair, tokenA, tokenB, tokenC, deployer, alice, bob };
  }

  it("first depositor permanently locks MINIMUM_LIQUIDITY (1000)", async function () {
    const { pair, deployer } = await deployFixture();

    await pair.write.addLiquidity([parseEther("100"), parseEther("100")]);

    const minLiq = (await pair.read.MINIMUM_LIQUIDITY()) as bigint;
    const totalSupply = (await pair.read.totalSupply()) as bigint;
    const deployerLp = (await pair.read.balanceOf([deployer.account.address])) as bigint;

    assert.equal(minLiq, 1000n);
    assert.equal(totalSupply, parseEther("100"));
    assert.equal(deployerLp, parseEther("100") - 1000n);
  });

  it("rejects tiny first deposit that cannot exceed MINIMUM_LIQUIDITY", async function () {
    const { pair } = await deployFixture();

    await assert.rejects(
      pair.write.addLiquidity([1000n, 1000n]),
      /InsufficientLiquidity/
    );
  });

  it("subsequent liquidity provision mints proportional to the smaller side", async function () {
    const { pair, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("100"), parseEther("100")]);

    // Alice deposits out of ratio: 50 A and 80 B -> min(50%, 80%) = 50% of totalSupply
    await pair.write.addLiquidity([parseEther("50"), parseEther("80")], {
      account: alice.account,
    });

    const aliceLp = (await pair.read.balanceOf([alice.account.address])) as bigint;
    assert.equal(aliceLp, parseEther("50"));
    assert.equal(await pair.read.reserve0(), parseEther("150"));
    assert.equal(await pair.read.reserve1(), parseEther("180"));
  });

  it("removeLiquidity burns LP tokens and returns proportional reserves", async function () {
    const { pair, tokenA, tokenB, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("100"), parseEther("200")]);
    await pair.write.addLiquidity([parseEther("50"), parseEther("100")], {
      account: alice.account,
    });

    const aliceLpBefore = (await pair.read.balanceOf([alice.account.address])) as bigint;
    const balABefore = (await tokenA.read.balanceOf([alice.account.address])) as bigint;
    const balBBefore = (await tokenB.read.balanceOf([alice.account.address])) as bigint;

    await pair.write.removeLiquidity([aliceLpBefore], { account: alice.account });

    const aliceLpAfter = (await pair.read.balanceOf([alice.account.address])) as bigint;
    const balAAfter = (await tokenA.read.balanceOf([alice.account.address])) as bigint;
    const balBAfter = (await tokenB.read.balanceOf([alice.account.address])) as bigint;

    assert.equal(aliceLpAfter, 0n);
    assert.equal(balAAfter - balABefore, parseEther("50"));
    assert.equal(balBAfter - balBBefore, parseEther("100"));
  });

  it("supports swapping token1 for token0 as well", async function () {
    const { pair, tokenB, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

    const amountIn = parseEther("100");
    const expectedOut = (await pair.read.getAmountOut([
      amountIn,
      parseEther("1000"),
      parseEther("1000"),
    ])) as bigint;

    await pair.write.swap([tokenB.address, amountIn, expectedOut], {
      account: alice.account,
    });

    assert.equal(await pair.read.reserve1(), parseEther("1100"));
    assert.equal(await pair.read.reserve0(), parseEther("1000") - expectedOut);
  });

  it("reverts on slippage (amountOut < minAmountOut)", async function () {
    const { pair, tokenA, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

    const amountIn = parseEther("100");
    const expectedOut = (await pair.read.getAmountOut([
      amountIn,
      parseEther("1000"),
      parseEther("1000"),
    ])) as bigint;

    await assert.rejects(
      pair.write.swap([tokenA.address, amountIn, expectedOut + 1n], {
        account: alice.account,
      }),
      /InsufficientOutput/
    );
  });

  it("reverts when swapping an invalid token address", async function () {
    const { pair, tokenC, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

    await assert.rejects(
      pair.write.swap([tokenC.address, parseEther("10"), 0n], {
        account: alice.account,
      }),
      /InvalidToken/
    );
  });

  it("reverts on zero amounts and empty pool math", async function () {
    const { pair, tokenA, alice } = await deployFixture();

    await assert.rejects(
      pair.read.getAmountOut([0n, parseEther("100"), parseEther("100")]),
      /InsufficientAmount/
    );
    await assert.rejects(
      pair.read.getAmountOut([parseEther("10"), 0n, parseEther("100")]),
      /InsufficientLiquidity/
    );
    await assert.rejects(
      pair.write.addLiquidity([0n, parseEther("10")]),
      /InsufficientAmount/
    );

    await pair.write.addLiquidity([parseEther("100"), parseEther("100")]);
    await assert.rejects(
      pair.write.swap([tokenA.address, 0n, 0n], { account: alice.account }),
      /InsufficientAmount/
    );
    await assert.rejects(
      pair.write.removeLiquidity([0n], { account: alice.account }),
      /InsufficientAmount/
    );
  });
});