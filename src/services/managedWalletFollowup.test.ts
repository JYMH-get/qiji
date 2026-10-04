import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Endpoints, type SessionTeamInfo } from "@/contract";
import { useConnectionStore } from "@/store/connectionStore";
import { managedClient } from "@/services/managedClient";

const boundaries = vi.hoisted(() => ({
	canvasAlive: vi.fn(), createCanvas: vi.fn(), findCanvas: vi.fn(),
	queryVideo: vi.fn(), runVideo: vi.fn(), uploadRef: vi.fn(),
	dreaminaQuery: vi.fn(), dreaminaSubmit: vi.fn(),
	comfyGet: vi.fn(), comfyPost: vi.fn(), comfyUpload: vi.fn(), pickComfy: vi.fn(),
	material: vi.fn(), probe: vi.fn(),
}));
vi.mock("@/store/libtvStore", () => ({ isLibtvAuthed: () => true }));
vi.mock("@/store/dreaminaStore", () => ({ isDreaminaAuthed: () => true }));
vi.mock("@/store/comfyuiStore", () => ({
	isComfyuiBound: () => true, pickComfyEndpoint: boundaries.pickComfy,
	comfyEndpointById: vi.fn(), enabledComfyEndpoints: () => [],
}));
vi.mock("@/services/libtvCli", () => ({
	libtvCanvasAlive: boundaries.canvasAlive, libtvCreateCanvas: boundaries.createCanvas,
	libtvFindCanvasByName: boundaries.findCanvas, libtvQueryNodeVideoUrl: boundaries.queryVideo,
	libtvRunVideoNode: boundaries.runVideo, libtvUploadRef: boundaries.uploadRef,
}));
vi.mock("@/services/dreaminaCli", () => ({ dreaminaQueryTask: boundaries.dreaminaQuery, dreaminaSubmitVideo: boundaries.dreaminaSubmit }));
vi.mock("@/services/comfyuiClient", () => ({ comfyGet: boundaries.comfyGet, comfyPostJson: boundaries.comfyPost, comfyUpload: boundaries.comfyUpload }));
vi.mock("@/services/assetRecover", () => ({ resolveMaterialLocalPathOrThrow: boundaries.material, newProbeScope: boundaries.probe }));

import { libtvAdapters } from "@/services/adapters/libtvAdapter";
import { dreaminaAdapters } from "@/services/adapters/dreaminaAdapter";
import { comfyuiAdapters } from "@/services/adapters/comfyuiAdapter";

const initial = useConnectionStore.getState();
const fetchMock = vi.fn<typeof fetch>();
const team = (): SessionTeamInfo => ({
	id: "fixture-team", name: "测试团队", role: "member", creditMode: "shared",
	memberCount: 2, poolCredits: 70, teamCredits: 70, personalCredits: 100, paymentSource: "team",
});
function login() {
	useConnectionStore.setState({
		serverUrl: "http://wallet-fixture.invalid", accessKey: "fixture-key", account: "fixture-a",
		loggedIn: true, user: { id: "fixture-a", name: "A", credits: 70, ownCredits: 100, team: team() },
	});
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
	status, headers: { "Content-Type": "application/json" },
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function toppedUpWallet() {
	return { ok: true, added: 25, credits: 70, ownCredits: 125, team: { ...team(), personalCredits: 125 } };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockRejectedValue(new Error("Unconfigured test request"));
	login();
});
afterEach(() => {
	useConnectionStore.setState(initial);
	vi.unstubAllGlobals();
});

describe.each([
	["积分码", (code: string) => managedClient.redeem(code), Endpoints.redeem],
	["会员卡", (code: string) => managedClient.redeemMembershipCard(code), Endpoints.membershipRedeem],
] as const)("%s 钱包响应", (_label, redeem, endpoint) => {
	it("个人充值增加个人余额，保持当前团队支付和团队余额", async () => {
		fetchMock.mockResolvedValueOnce(json(toppedUpWallet()));
		expect(await redeem("fixture-code")).toMatchObject({ ok: true, added: 25, credits: 70 });
		expect(useConnectionStore.getState().user).toMatchObject({
			credits: 70, ownCredits: 125, team: { personalCredits: 125, teamCredits: 70, poolCredits: 70, paymentSource: "team" },
		});
		expect(fetchMock).toHaveBeenCalledWith(`http://wallet-fixture.invalid${endpoint}`, expect.objectContaining({
			method: "POST", body: JSON.stringify({ code: "fixture-code" }),
			headers: expect.objectContaining({ Authorization: "Bearer fixture-key" }),
		}));
	});

	it("选择个人支付时刷新个人可用余额，团队余额仍独立", async () => {
		const current = useConnectionStore.getState().user!;
		useConnectionStore.setState({ user: { ...current, credits: 100, team: { ...team(), paymentSource: "personal" } } });
		fetchMock.mockResolvedValueOnce(json({ ...toppedUpWallet(), credits: 125, team: { ...team(), personalCredits: 125, paymentSource: "personal" } }));
		await redeem("fixture-code");
		expect(useConnectionStore.getState().user).toMatchObject({ credits: 125, ownCredits: 125, team: { teamCredits: 70, paymentSource: "personal" } });
	});

	it.each(["user", "key", "server", "logout"] as const)("等待响应期间切换 %s，旧响应不能写入当前钱包", async (change) => {
		const slow = deferred<Response>();
		fetchMock.mockReturnValueOnce(slow.promise);
		const pending = redeem("fixture-code");
		const user = { ...useConnectionStore.getState().user!, credits: 300, ownCredits: 500, team: { ...team(), teamCredits: 300, personalCredits: 500 } };
		useConnectionStore.setState({ user });
		if (change === "user") useConnectionStore.setState({ user: { ...user, id: "fixture-b" } });
		if (change === "key") useConnectionStore.setState({ accessKey: "fixture-new-key" });
		if (change === "server") useConnectionStore.setState({ serverUrl: "http://other-fixture.invalid" });
		if (change === "logout") useConnectionStore.setState({ loggedIn: false, accessKey: "", user: null });
		const expected = useConnectionStore.getState().user;
		slow.resolve(json(toppedUpWallet()));
		expect((await pending).ok).toBe(true);
		expect(useConnectionStore.getState().user).toBe(expected);
	});
});

describe("团队手续费预检先于任何本地渠道操作", () => {
	it.each([
		["LibTV", libtvAdapters[0]], ["即梦", dreaminaAdapters[0]], ["ComfyUI", comfyuiAdapters[0]],
	] as const)("%s 等待预检，预检失败不执行素材或 CLI/直连调用", async (_name, adapter) => {
		const slow = deferred<Response>();
		fetchMock.mockReturnValueOnce(slow.promise);
		const pending = adapter.submit({ prompt: "fixture" }, {});
		const rejected = expect(pending).rejects.toThrow("团队积分不足，请联系团长");
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledTimes(1);
    if(_name==='ComfyUI') expect(fetchMock).toHaveBeenCalledWith(`http://wallet-fixture.invalid${Endpoints.thirdPartyFeePrecheck}`, expect.objectContaining({ method: "POST", body: "{}" }));
    else expect(fetchMock).toHaveBeenCalledWith('http://wallet-fixture.invalid/v1/local-generation-reports',expect.objectContaining({method:'POST'}));
		for (const call of Object.values(boundaries)) expect(call).not.toHaveBeenCalled();
		slow.resolve(json({ error: { message: "团队积分不足，请联系团长" } }, 402));
		await rejected;
		for (const call of Object.values(boundaries)) expect(call).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(useConnectionStore.getState().user).toMatchObject({ credits: 70, ownCredits: 100, team: { paymentSource: "team", teamCredits: 70 } });
	});
});
