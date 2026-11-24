// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title PriceVotingWithdrawal
/// @notice Allows token holders to vote on a token price and withdraw their locked stake at any time.
/// @dev Tracks all active prices in a fixed-depth 32-byte (256-bit) radix-256 trie keyed by `(weight, price)`.
///      Every trie traversal is strictly bounded by a compile-time constant (`KEY_BYTES = 32`), so gas cost
///      per operation never grows with the number of distinct voter-proposed prices.
///      Tie-breaking rule: when multiple prices share the exact same highest `totalWeightAtPrice`,
///      the higher numeric price (`priceA > priceB`) wins.
contract PriceVotingWithdrawal {
    IERC20 public immutable token;
    uint256 public immutable votingEnd;

    // Total tokens currently locked for each price
    mapping(uint256 => uint256) public totalWeightAtPrice;

    // Tokens locked by each voter for each price
    mapping(address => mapping(uint256 => uint256)) public lockedBalance;

    // Fixed-depth radix-256 trie over composite key: (uint128(weight) << 128) | uint128(price)
    // Each level consumes 8 bits (1 byte), so every key takes exactly 32 constant steps.
    uint256 private constant KEY_BYTES = 32;
    uint256 private constant ROOT_NODE = 1;
    uint256 private _nextNodeId = 2;

    mapping(uint256 => mapping(uint256 => uint256)) private _children;
    mapping(uint256 => uint256) private _childMask;
    mapping(uint256 => uint256) private _subTreeCount;
    mapping(uint256 => uint256) private _leafPrice;

    error VotingEnded();
    error VotingNotEnded();
    error InvalidAmount();
    error InsufficientLockedBalance();
    error NoVotes();
    error TokenTransferFailed();
    error InvalidVotingEnd();
    error ValueOutOfRange();

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

        uint256 oldWeight = totalWeightAtPrice[price];
        uint256 newWeight = oldWeight + amount;
        if (price > type(uint128).max || newWeight > type(uint128).max) {
            revert ValueOutOfRange();
        }

        if (oldWeight > 0) {
            _removeKey(_encodeKey(oldWeight, price));
        }

        lockedBalance[msg.sender][price] += amount;
        totalWeightAtPrice[price] = newWeight;
        _insertKey(_encodeKey(newWeight, price), price);

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

        uint256 oldWeight = totalWeightAtPrice[price];
        uint256 newWeight = oldWeight - amount;

        _removeKey(_encodeKey(oldWeight, price));

        lockedBalance[msg.sender][price] -= amount;
        totalWeightAtPrice[price] = newWeight;

        if (newWeight > 0) {
            _insertKey(_encodeKey(newWeight, price), price);
        }

        if (!token.transfer(msg.sender, amount)) {
            revert TokenTransferFailed();
        }

        emit TokensWithdrawn(msg.sender, price, amount);
    }

    /// @notice Returns the winning price after voting ends in bounded constant time (32 radix steps).
    /// @dev Tie-breaking rule: among prices tied for the highest `totalWeightAtPrice`, the higher price wins.
    function winningPrice() external view returns (uint256) {
        if (block.timestamp < votingEnd) {
            revert VotingNotEnded();
        }
        if (_subTreeCount[ROOT_NODE] == 0) {
            revert NoVotes();
        }

        uint256 node = ROOT_NODE;
        for (uint256 step = 0; step < KEY_BYTES; step++) {
            uint256 bestBucket = _highestBit(_childMask[node]);
            node = _children[node][bestBucket];
        }

        return _leafPrice[node];
    }

    function _encodeKey(uint256 weight, uint256 price) private pure returns (uint256) {
        return (weight << 128) | price;
    }

    function _insertKey(uint256 key, uint256 price) private {
        uint256 node = ROOT_NODE;
        _subTreeCount[node] += 1;

        for (uint256 step = 0; step < KEY_BYTES; step++) {
            uint256 shift = (KEY_BYTES - 1 - step) * 8;
            uint256 bucket = (key >> shift) & 0xff;
            uint256 child = _children[node][bucket];
            if (child == 0) {
                child = _nextNodeId++;
                _children[node][bucket] = child;
            }
            if (_subTreeCount[child] == 0) {
                _childMask[node] |= (uint256(1) << bucket);
            }
            node = child;
            _subTreeCount[node] += 1;
        }

        _leafPrice[node] = price;
    }

    function _removeKey(uint256 key) private {
        uint256 node = ROOT_NODE;
        _subTreeCount[node] -= 1;

        for (uint256 step = 0; step < KEY_BYTES; step++) {
            uint256 shift = (KEY_BYTES - 1 - step) * 8;
            uint256 bucket = (key >> shift) & 0xff;
            uint256 child = _children[node][bucket];
            uint256 nextCount = _subTreeCount[child] - 1;
            _subTreeCount[child] = nextCount;
            if (nextCount == 0) {
                _childMask[node] &= ~(uint256(1) << bucket);
            }
            node = child;
        }
    }

    function _highestBit(uint256 x) private pure returns (uint256 r) {
        if (x >= 1 << 128) {
            x >>= 128;
            r += 128;
        }
        if (x >= 1 << 64) {
            x >>= 64;
            r += 64;
        }
        if (x >= 1 << 32) {
            x >>= 32;
            r += 32;
        }
        if (x >= 1 << 16) {
            x >>= 16;
            r += 16;
        }
        if (x >= 1 << 8) {
            x >>= 8;
            r += 8;
        }
        if (x >= 1 << 4) {
            x >>= 4;
            r += 4;
        }
        if (x >= 1 << 2) {
            x >>= 2;
            r += 2;
        }
        if (x >= 1 << 1) {
            r += 1;
        }
    }
}