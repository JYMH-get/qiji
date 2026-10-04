/** Reporting ownership is independent of the wallet/payer used for billing. */
export interface UsageReportScope {
  companyId: string;
  companyName: string;
  groupId: string;
  groupName: string;
  mode: 'shared' | 'dispatch' | 'personal' | 'unknown';
  userId: string;
  name: string;
  account: string;
  role: '团长' | '成员' | '个人' | '历史人员';
}
