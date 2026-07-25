// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ═══════════════════════════════════════════════════════════════════════════
// FILE: contracts/alucard.sol
// ALUCARD Sovereign Protocol — rename file only for each new system
// Handles: flash loans, JIT execution, liquidations, recursive compounding
// Treasury wallet: 0xCCCF1C9A2154750A0D7CceeD51fE0f9b4c1906e8
// Executor wallet: 0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39
// ═══════════════════════════════════════════════════════════════════════════

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IBalancerVault {
    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external;
}

interface IAavePool {
    function flashLoan(address receiverAddress, address[] calldata assets, uint256[] calldata amounts, uint256[] calldata interestRateModes, address onBehalfOf, bytes calldata params, uint16 referralCode) external;
    function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external;
}

interface INonfungiblePositionManager {
    struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }
    struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }
    struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }
    function mint(MintParams calldata params) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external returns (uint256 amount0, uint256 amount1);
    function burn(uint256 tokenId) external;
}

contract Alucard {
    address public immutable owner;
    address public immutable treasury;
    address constant BALANCER = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant NFPM     = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;

    modifier onlyOwner() { require(msg.sender == owner, "!owner"); _; }

    constructor(address _treasury) {
        owner    = msg.sender;
        treasury = _treasury;
    }

    // ── FLASH LOAN ENTRY (Balancer) ───────────────────────────────────────────
    function executeFlash(
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external onlyOwner {
        IBalancerVault(BALANCER).flashLoan(address(this), tokens, amounts, userData);
    }

    // ── BALANCER FLASH CALLBACK ───────────────────────────────────────────────
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == BALANCER, "!balancer");
        (uint8 strategyType, bytes memory stratData) = abi.decode(userData, (uint8, bytes));

        if (strategyType == 1) _executeJIT(tokens, amounts, stratData);
        else if (strategyType == 2) _executeLiquidation(tokens, amounts, stratData);
        else if (strategyType == 3) _executeRecursive(tokens, amounts, stratData);
        else if (strategyType == 4) _executeArb(tokens, amounts, stratData);

        // Repay flash loan
        for (uint i; i < tokens.length; ) {
            IERC20(tokens[i]).transfer(BALANCER, amounts[i] + feeAmounts[i]);
            unchecked { ++i; }
        }
    }

    // ── JIT LIQUIDITY ─────────────────────────────────────────────────────────
    function _executeJIT(address[] memory tokens, uint256[] memory amounts, bytes memory data) internal {
        (address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 minProfit) =
            abi.decode(data, (address, address, uint24, int24, int24, uint256));

        IERC20(tokens[0]).approve(NFPM, amounts[0]);

        (uint256 tokenId, uint128 liquidity,,) = INonfungiblePositionManager(NFPM).mint(
            INonfungiblePositionManager.MintParams({
                token0: token0, token1: token1, fee: fee,
                tickLower: tickLower, tickUpper: tickUpper,
                amount0Desired: amounts[0], amount1Desired: 0,
                amount0Min: 0, amount1Min: 0,
                recipient: address(this), deadline: block.timestamp + 60
            })
        );

        // Swap executes in same block — collect fees
        INonfungiblePositionManager(NFPM).decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId, liquidity: liquidity,
                amount0Min: 0, amount1Min: 0, deadline: block.timestamp
            })
        );

        (uint256 c0, uint256 c1) = INonfungiblePositionManager(NFPM).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: address(this),
                amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );

        INonfungiblePositionManager(NFPM).burn(tokenId);
        require(c0 + c1 >= minProfit, "!profit");
        _sweep(tokens[0]);
    }

    // ── LIQUIDATION ───────────────────────────────────────────────────────────
    function _executeLiquidation(address[] memory tokens, uint256[] memory amounts, bytes memory data) internal {
        (address aavePool, address collateral, address debt, address user, uint256 debtAmount) =
            abi.decode(data, (address, address, address, address, uint256));
        IERC20(debt).approve(aavePool, debtAmount);
        IAavePool(aavePool).liquidationCall(collateral, debt, user, debtAmount, false);
        _sweep(collateral);
        _sweep(debt);
    }

    // ── RECURSIVE COMPOUNDING (Model 2 inner cycle) ───────────────────────────
    function _executeRecursive(address[] memory tokens, uint256[] memory amounts, bytes memory data) internal {
        (bytes memory innerData) = abi.decode(data, (bytes));
        // Re-enter flash with 50% of current balance as new seed
        uint256 seed = IERC20(tokens[0]).balanceOf(address(this));
        if (seed > 50000e6) {  // minimum $50K seed
            address[] memory t = new address[](1); t[0] = tokens[0];
            uint256[] memory a = new uint256[](1); a[0] = seed * 80;  // 80× Aave leverage
            try IBalancerVault(BALANCER).flashLoan(address(this), t, a, innerData) {} catch {}
        }
    }

    // ── ARB ───────────────────────────────────────────────────────────────────
    function _executeArb(address[] memory tokens, uint256[] memory, bytes memory data) internal {
        (address router, bytes memory swapData, uint256 minProfit) =
            abi.decode(data, (address, bytes, uint256));
        IERC20(tokens[0]).approve(router, type(uint256).max);
        (bool ok,) = router.call(swapData);
        require(ok && IERC20(tokens[0]).balanceOf(address(this)) >= minProfit, "!arb");
        _sweep(tokens[0]);
    }

    // ── SWEEP PROFITS TO TREASURY ─────────────────────────────────────────────
    function _sweep(address token) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(treasury, bal);
    }

    function sweep(address[] calldata tokens) external onlyOwner {
        for (uint i; i < tokens.length; ) { _sweep(tokens[i]); unchecked{++i;} }
    }

    receive() external payable {}
    fallback() external payable {}
}
