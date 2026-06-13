/**
 * 积分账本：受理任务时预扣，失败退回。
 * 错峰排期不打折（仅排队错峰，计价不变）。
 */
export class CreditLedger {
	private balance: number;
	private holds = new Map<string, number>();
	constructor(initial = 0) {
		this.balance = initial;
	}
	get available(): number {
		return this.balance;
	}
	/** 受理时预扣 */
	hold(taskId: string, cost: number): boolean {
		if (cost > this.balance) return false;
		this.balance -= cost;
		this.holds.set(taskId, cost);
		return true;
	}
	/** 成功：扣减落定 */
	settle(taskId: string): void {
		this.holds.delete(taskId);
	}
	/** 失败：退回预扣 */
	refund(taskId: string): void {
		const cost = this.holds.get(taskId);
		if (cost != null) {
			this.balance += cost;
			this.holds.delete(taskId);
		}
	}
}

export const creditLedger = new CreditLedger(1000);
