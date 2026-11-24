// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title PriceVotingWithdrawal
/// @notice Allows token holders to vote on a token price and withdraw their locked stake at any time.
/// @dev Maintains an on-chain binary max-heap of active voted prices so `winningPrice()` executes in O(1)
///      without unbounded iteration over voter-controlled prices.
///      Tie-breaking rule: if multiple prices share the exact same highest total weight, the higher numeric
///      price wins (`priceA > priceB`).
contract PriceVotingWithdrawal {
    IERC20 public immutable token;
    uint256 public immutable votingEnd;

    // Total tokens currently locked for each price
    mapping(uint256 => uint256) public totalWeightAtPrice;

    // Tokens locked by each voter for each price
    mapping(address => mapping(uint256 => uint256)) public lockedBalance;

    // Max-heap of prices with non-zero weight (0-indexed array) and 1-based position lookup (0 = absent)
    uint256[] private _priceHeap;
    mapping(uint256 => uint256) private _heapPos;

    error VotingEnded();
    error VotingNotEnded();
    error InvalidAmount();
    error InsufficientLockedBalance();
    error NoVotes();
    error TokenTransferFailed();
    error InvalidVotingEnd();

    event VoteCast(address indexed voter, uint256 indexed price, uint256 amount);
    event TokensWithdrawn(address indexed voter, uint256 indexed price, uint256 amount);

    constructor(IERC20 _token, uint256 _votingEnd) {
        if (_votingEnd <= block.timestamp) {
            revert InvalidVotingEnd();
        }

        token = _token;
        votingEnd = _votingEnd;
    }

    /// @notice Vote by locking `amount` tokens behind `price`.
    function vote(uint256 price, uint256 amount) external {
        if (block.timestamp >= votingEnd) {
            revert VotingEnded();
        }
        if (amount == 0) {
            revert InvalidAmount();
        }

        lockedBalance[msg.sender][price] += amount;
        totalWeightAtPrice[price] += amount;
        _onWeightIncreased(price);

        if (!token.transferFrom(msg.sender, address(this), amount)) {
            revert TokenTransferFailed();
        }

        emit VoteCast(msg.sender, price, amount);
    }

    /// @notice Withdraw `amount` previously locked tokens from `price` at any time.
    function withdraw(uint256 price, uint256 amount) external {
        if (amount == 0) {
            revert InvalidAmount();
        }
        if (lockedBalance[msg.sender][price] < amount) {
            revert InsufficientLockedBalance();
        }

        lockedBalance[msg.sender][price] -= amount;
        totalWeightAtPrice[price] -= amount;
        _onWeightDecreased(price);

        if (!token.transfer(msg.sender, amount)) {
            revert TokenTransferFailed();
        }

        emit TokensWithdrawn(msg.sender, price, amount);
    }

    /// @notice Returns the winning price after voting ends in O(1) time.
    /// @dev Tie-breaking rule: among prices tied for the highest `totalWeightAtPrice`, the higher price wins.
    function winningPrice() external view returns (uint256) {
        if (block.timestamp < votingEnd) {
            revert VotingNotEnded();
        }
        if (_priceHeap.length == 0 || totalWeightAtPrice[_priceHeap[0]] == 0) {
            revert NoVotes();
        }

        return _priceHeap[0];
    }

    /// @dev Returns true if `priceA` ranks ahead of `priceB` under higher-weight-first,
    ///      higher-price-breaks-ties ordering.
    function _ranksAbove(uint256 priceA, uint256 priceB) private view returns (bool) {
        uint256 weightA = totalWeightAtPrice[priceA];
        uint256 weightB = totalWeightAtPrice[priceB];
        if (weightA != weightB) {
            return weightA > weightB;
        }
        return priceA > priceB;
    }

    function _onWeightIncreased(uint256 price) private {
        uint256 pos = _heapPos[price];
        if (pos == 0) {
            _priceHeap.push(price);
            uint256 idx = _priceHeap.length - 1;
            _heapPos[price] = idx + 1;
            _siftUp(idx);
        } else {
            _siftUp(pos - 1);
        }
    }

    function _onWeightDecreased(uint256 price) private {
        uint256 pos = _heapPos[price];
        if (pos == 0) return;

        uint256 idx = pos - 1;
        if (totalWeightAtPrice[price] == 0) {
            uint256 lastIdx = _priceHeap.length - 1;
            if (idx != lastIdx) {
                uint256 movedPrice = _priceHeap[lastIdx];
                _priceHeap[idx] = movedPrice;
                _heapPos[movedPrice] = idx + 1;
                _priceHeap.pop();
                delete _heapPos[price];
                _siftUp(idx);
                _siftDown(idx);
            } else {
                _priceHeap.pop();
                delete _heapPos[price];
            }
        } else {
            _siftDown(idx);
        }
    }

    function _siftUp(uint256 idx) private {
        while (idx > 0) {
            uint256 parentIdx = (idx - 1) / 2;
            uint256 currentPrice = _priceHeap[idx];
            uint256 parentPrice = _priceHeap[parentIdx];
            if (!_ranksAbove(currentPrice, parentPrice)) {
                break;
            }
            _priceHeap[idx] = parentPrice;
            _heapPos[parentPrice] = idx + 1;
            _priceHeap[parentIdx] = currentPrice;
            _heapPos[currentPrice] = parentIdx + 1;
            idx = parentIdx;
        }
    }

    function _siftDown(uint256 idx) private {
        uint256 len = _priceHeap.length;
        while (true) {
            uint256 left = 2 * idx + 1;
            if (left >= len) break;

            uint256 best = idx;
            if (_ranksAbove(_priceHeap[left], _priceHeap[best])) {
                best = left;
            }
            uint256 right = left + 1;
            if (right < len && _ranksAbove(_priceHeap[right], _priceHeap[best])) {
                best = right;
            }
            if (best == idx) break;

            uint256 currentPrice = _priceHeap[idx];
            uint256 bestPrice = _priceHeap[best];
            _priceHeap[idx] = bestPrice;
            _heapPos[bestPrice] = idx + 1;
            _priceHeap[best] = currentPrice;
            _heapPos[currentPrice] = best + 1;
            idx = best;
        }
    }
}