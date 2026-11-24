# Reflection

**Implementation Strategy:**

I used a withdrawal-aware voting strategy. Whenever a user withdraws tokens, the voting weight for that price is reduced by the withdrawn amount.

After the voting period ends, the contract calculates the winning price using the remaining voting weights.

**Why not use the previous leader-tracking method?**

In the previous task, the contract tracked the leading price continuously. But when users withdraw tokens, the leader can change. Maintaining the leader after every withdrawal can make the contract more complicated.

Therefore, I calculate the winning price after voting ends using the updated voting weights. This makes the implementation simpler and handles withdrawals correctly.