// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract Pair is ERC20 {
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    address private constant DEAD_ADDRESS = address(0xdead);

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;

    error InsufficientLiquidity();
    error InsufficientAmount();
    error InsufficientOutput();
    error InvalidToken();

    event LiquidityAdded(address indexed who, uint256 amount0, uint256 amount1, uint256 liquidity);
    event LiquidityRemoved(address indexed who, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swapped(address indexed who, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 _token0, IERC20 _token1) ERC20("Simple AMM LP", "sLP") {
        token0 = _token0;
        token1 = _token1;
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountIn == 0) revert InsufficientAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * 1000) + amountInWithFee;
        return numerator / denominator;
    }

    function addLiquidity(uint256 amount0, uint256 amount1) external returns (uint256 liquidity) {
        if (amount0 == 0 || amount1 == 0) revert InsufficientAmount();

        uint256 balance0Before = token0.balanceOf(address(this));
        uint256 balance1Before = token1.balanceOf(address(this));

        token0.transferFrom(msg.sender, address(this), amount0);
        token1.transferFrom(msg.sender, address(this), amount1);

        uint256 received0 = token0.balanceOf(address(this)) - balance0Before;
        uint256 received1 = token1.balanceOf(address(this)) - balance1Before;

        uint256 _totalSupply = totalSupply();
        if (_totalSupply == 0) {
            uint256 root = _sqrt(received0 * received1);
            if (root <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            liquidity = root - MINIMUM_LIQUIDITY;
            _mint(DEAD_ADDRESS, MINIMUM_LIQUIDITY);
        } else {
            liquidity = _min(
                (received0 * _totalSupply) / reserve0,
                (received1 * _totalSupply) / reserve1
            );
        }

        if (liquidity == 0) revert InsufficientLiquidity();

        _mint(msg.sender, liquidity);
        _syncReserves();

        emit LiquidityAdded(msg.sender, amount0, amount1, liquidity);
    }

    function removeLiquidity(uint256 liquidity) external returns (uint256 amount0, uint256 amount1) {
        if (liquidity == 0) revert InsufficientAmount();

        uint256 _totalSupply = totalSupply();
        if (_totalSupply == 0) revert InsufficientLiquidity();

        amount0 = (liquidity * reserve0) / _totalSupply;
        amount1 = (liquidity * reserve1) / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();

        _burn(msg.sender, liquidity);

        token0.transfer(msg.sender, amount0);
        token1.transfer(msg.sender, amount1);
        _syncReserves();

        emit LiquidityRemoved(msg.sender, amount0, amount1, liquidity);
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut) {
        bool isToken0 = tokenIn == address(token0);
        if (!isToken0 && tokenIn != address(token1)) revert InvalidToken();

        (IERC20 inToken, IERC20 outToken, uint256 resIn, uint256 resOut) = isToken0
            ? (token0, token1, reserve0, reserve1)
            : (token1, token0, reserve1, reserve0);

        uint256 inBalanceBefore = inToken.balanceOf(address(this));
        inToken.transferFrom(msg.sender, address(this), amountIn);
        uint256 actualAmountIn = inToken.balanceOf(address(this)) - inBalanceBefore;

        amountOut = getAmountOut(actualAmountIn, resIn, resOut);
        if (amountOut < minAmountOut) revert InsufficientOutput();

        outToken.transfer(msg.sender, amountOut);
        _syncReserves();

        emit Swapped(msg.sender, tokenIn, actualAmountIn, amountOut);
    }

    function _syncReserves() private {
        reserve0 = token0.balanceOf(address(this));
        reserve1 = token1.balanceOf(address(this));
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}