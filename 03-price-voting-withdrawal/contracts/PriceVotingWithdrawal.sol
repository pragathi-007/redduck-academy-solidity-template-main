
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PriceVotingWithdrawal {

    IERC20 public immutable token;
    uint256 public immutable votingEnd;

    // Total tokens locked for each price
    mapping(uint256 => uint256) public totalWeightAtPrice;

    // Tokens locked by each voter for each price
    mapping(address => mapping(uint256 => uint256))
        public lockedBalance;

    // Store all prices that have received votes
    uint256[] private prices;

    // Check whether a price is already registered
    mapping(uint256 => bool) private priceExists;

    error VotingEnded();
    error VotingNotEnded();
    error InvalidAmount();
    error InsufficientLockedBalance();
    error NoVotes();
    error TokenTransferFailed();
    error InvalidVotingEnd();

    event VoteCast(
        address indexed voter,
        uint256 indexed price,
        uint256 amount
    );

    event TokensWithdrawn(
        address indexed voter,
        uint256 indexed price,
        uint256 amount
    );

    constructor(IERC20 _token, uint256 _votingEnd) {
        if (_votingEnd <= block.timestamp) {
            revert InvalidVotingEnd();
        }

        token = _token;
        votingEnd = _votingEnd;
    }

    // Vote by locking tokens behind a price
    function vote(uint256 price, uint256 amount) external {

        if (block.timestamp >= votingEnd) {
            revert VotingEnded();
        }

        if (amount == 0) {
            revert InvalidAmount();
        }

        if (!priceExists[price]) {
            priceExists[price] = true;
            prices.push(price);
        }

        lockedBalance[msg.sender][price] += amount;
        totalWeightAtPrice[price] += amount;

        if (!token.transferFrom(msg.sender, address(this), amount)) {
            revert TokenTransferFailed();
        }

        emit VoteCast(msg.sender, price, amount);
    }

    // Withdraw locked tokens at any time
    function withdraw(uint256 price, uint256 amount) external {

        if (amount == 0) {
            revert InvalidAmount();
        }

        if (lockedBalance[msg.sender][price] < amount) {
            revert InsufficientLockedBalance();
        }

        lockedBalance[msg.sender][price] -= amount;
        totalWeightAtPrice[price] -= amount;

        if (!token.transfer(msg.sender, amount)) {
            revert TokenTransferFailed();
        }

        emit TokensWithdrawn(msg.sender, price, amount);
    }

    // Find the winning price after voting ends
    function winningPrice() external view returns (uint256) {

        if (block.timestamp < votingEnd) {
            revert VotingNotEnded();
        }

        uint256 highestWeight = 0;
        uint256 winner = 0;

        for (uint256 i = 0; i < prices.length; i++) {

            uint256 currentPrice = prices[i];
            uint256 currentWeight = totalWeightAtPrice[currentPrice];

            if (currentWeight > highestWeight) {
                highestWeight = currentWeight;
                winner = currentPrice;
            }
        }

        if (highestWeight == 0) {
            revert NoVotes();
        }

        return winner;
    }
}
