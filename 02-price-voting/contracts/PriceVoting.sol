
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PriceVoting {
    IERC20 private immutable _token;
    uint256 private immutable _votingEnd;

    mapping(uint256 => uint256) private _weights;
    mapping(address => uint256) private _locked;
    mapping(address => bool) private _claimed;

    uint256 private _leaderPrice;
    uint256 private _leaderWeight;
    uint256 private _currentTokenPrice;

    bool private _isFinalized;
    bool private _isTie;

    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();

    event Voted(
        address indexed voter,
        uint256 indexed price,
        uint256 amount
    );

    event PriceFinalized(
        uint256 indexed price,
        uint256 weight
    );

    event Claimed(
        address indexed voter,
        uint256 amount
    );

    // Reflection:
    // If voters could withdraw locked tokens before votingEnd,
    // the _weights mapping could become incorrect.
    // A voter could vote, increase a price's weight, then withdraw
    // their tokens while the recorded weight remains unchanged.
    // This would allow the same tokens to be reused for voting
    // on another price, artificially inflating voting power.

    constructor(IERC20 token_, uint256 votingEnd_) {
        _token = token_;
        _votingEnd = votingEnd_;
    }

    // Write functions

    function vote(uint256 price, uint256 amount) external {
        if (block.timestamp >= _votingEnd) revert VotingEnded();
        if (amount == 0) revert ZeroAmount();

        bool success = _token.transferFrom(
            msg.sender,
            address(this),
            amount
        );

        if (!success) revert TransferFailed();

        _locked[msg.sender] += amount;

        uint256 newWeight = _weights[price] + amount;
        _weights[price] = newWeight;

        if (newWeight > _leaderWeight) {
            _leaderPrice = price;
            _leaderWeight = newWeight;
            _isTie = false;
        } else if (
            newWeight == _leaderWeight &&
            price != _leaderPrice
        ) {
            _isTie = true;
        }

        emit Voted(msg.sender, price, amount);
    }

    function finalize() external {
        if (_isFinalized) revert AlreadyFinalized();
        if (block.timestamp < _votingEnd) revert VotingActive();

        _isFinalized = true;

        uint256 winningWeight = 0;

        if (!_isTie && _leaderWeight > 0) {
            _currentTokenPrice = _leaderPrice;
            winningWeight = _leaderWeight;
        }

        emit PriceFinalized(_currentTokenPrice, winningWeight);
    }

    function claim() external {
        if (block.timestamp < _votingEnd) revert VotingActive();

        uint256 amount = _locked[msg.sender];

        if (amount == 0 || _claimed[msg.sender]) {
            revert NothingToClaim();
        }

        _claimed[msg.sender] = true;
        _locked[msg.sender] = 0;

        bool success = _token.transfer(msg.sender, amount);

        if (!success) revert TransferFailed();

        emit Claimed(msg.sender, amount);
    }

    // Read functions

    function token() external view returns (IERC20) {
        return _token;
    }

    function votingEnd() external view returns (uint256) {
        return _votingEnd;
    }

    function weightOf(uint256 price) external view returns (uint256) {
        return _weights[price];
    }

    function lockedOf(address voter) external view returns (uint256) {
        return _locked[voter];
    }

    function leader() external view returns (
        uint256 price,
        uint256 weight
    ) {
        return (_leaderPrice, _leaderWeight);
    }

    function currentTokenPrice() external view returns (uint256) {
        return _currentTokenPrice;
    }

    function finalized() external view returns (bool) {
        return _isFinalized;
    }
}
