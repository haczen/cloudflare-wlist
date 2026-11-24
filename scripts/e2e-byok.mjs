// E2E：站内未配 AI + 登录 + 接入自己的模型（浏览器直连）→ 测试 → 保存 → 聊天
// 前置：npm run dev(5173) 与 node scripts/mock-openai.mjs(8787) 已在跑
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://localhost:5173";
const ADMIN_USER = "admin";
const ADMIN_PASS = "/us597tusK/kLGVl";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[e2e]", ...a);
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

/** 在页面里按可见文本找按钮并点它（穿透 pointer-events:none / 遮罩） */
async function clickByText(page, text, scope = "button") {
	return page.evaluate(
		(t, sel) => {
			const els = [...document.querySelectorAll(sel)];
			const el = els.find((e) => (e.textContent || "").includes(t));
			if (!el) return false;
			el.click();
			return true;
		},
		text,
		scope
	);
}

async function waitForText(page, text, timeout = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const body = await page.evaluate(() => document.body.innerText);
		if (body.includes(text)) return true;
		await sleep(300);
	}
	return false;
}

const browser = await puppeteer.launch({
	executablePath: EDGE,
	headless: "new",
	args: ["--no-sandbox", "--disable-gpu"],
	defaultViewport: { width: 1400, height: 900 },
});
try {
	const page = await browser.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" && !/favicon|Live2D|pixi|Deprecation/i.test(m.text()))
			log("console.error:", m.text().slice(0, 160));
	});

	// ---- 1. 首页 & 关欢迎弹窗 ----
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
	await sleep(3000);
	if (await clickByText(page, "开始使用")) log("欢迎弹窗已关");
	await waitForText(page, "WList", 20000);
	check("首页打开", true);

	// ---- 2. 登录 admin ----
	await clickByText(page, "登录", "aside button");
	await sleep(800);
	const userInput = await page.$('input[autocomplete="username"]');
	await userInput.type(ADMIN_USER);
	await page.type('input[autocomplete="current-password"]', ADMIN_PASS);
	// 点与表单关联的提交按钮（footer 里那个 type=submit form=wlist-login-form）
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('button[form="wlist-login-form"]')].find(
			(b) => (b.textContent || "").includes("登录")
		);
		if (!btn) throw new Error("找不到登录提交按钮");
		btn.click();
	});
	check(
		"登录成功",
		await page.evaluate(() => !!document.querySelector("aside img")),
		"侧栏出现头像（displayName 非 username，故用头像判定）"
	);;
	// SPA 登录不刷新页面：userIdentity 变化应触发重新探测
	await sleep(2500);

	// ---- 3. 打开聊天面板：站内未配 AI → 输入框应禁用 ----
	await clickByText(page, "和我聊天", "button[title]");
	await sleep(1200);
	let chatInput = await page.$('input[maxlength="500"]');
	check("聊天面板打开", !!chatInput);
	const before = await page.evaluate(() => {
		const i = document.querySelector('input[maxlength="500"]');
		return { disabled: i?.disabled, placeholder: i?.placeholder || "" };
	});
	check(
		"未接入前输入框禁用",
		before.disabled === true,
		`placeholder="${before.placeholder.slice(0, 40)}"`
	);
	check(
		"登录后(站内未配AI)占位符引导接入",
		before.placeholder.includes("接入 AI"),
		before.placeholder
	);

	// ---- 4. ⚙ → 接入自己的模型：地址故意不带 /v1 ----
	await clickByText(page, "⚙");
	await sleep(800);
	const urlInput = await page.$('input[placeholder="https://api.deepseek.com/v1"]');
	await urlInput.type("http://127.0.0.1:8787"); // 不带 /v1：验证自动补
	await page.type('input[type="password"]', "ah-arbitrary-prefix-9876"); // 非 sk- 前缀必须放行
	await clickByText(page, "测试并获取模型");
	check("「测试并获取模型」发出", await waitForText(page, "✓ 连通", 20000), "等成功标记");

	const settingsText = await page.evaluate(() => document.body.innerText);
	check("模型清单拉到 3 个", /共 3 个模型/.test(settingsText));
	check("自动选中第一个 mock-mini", /mock-mini/.test(settingsText));

	// ---- 4b. 反向：垃圾 key（终端装饰线）必须被前端拦下，不发请求 ----
	{
		await page.evaluate(() => {
			const i = document.querySelector('input[type="password"]');
			const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
			set.call(i, "──────────────────────────────── ❯");
			i.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await clickByText(page, "测试并获取模型");
		const blocked = await waitForText(page, "✗", 5000);
		const txt = await page.evaluate(() => document.body.innerText);
		check("垃圾 key 被拦下", blocked && /终端界面|记事本/.test(txt));
		// 还原成真 key，继续后面的流程
		await page.evaluate(() => {
			const i = document.querySelector('input[type="password"]');
			const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
			set.call(i, "ah-arbitrary-prefix-9876");
			i.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await sleep(300);
	}

	// ---- 5. 保存 ----
	await clickByText(page, "保存并启用");
	check("保存成功提示", await waitForText(page, "✓ 已接入", 20000));
	await sleep(1000);

	// ---- 6. 回到聊天视图：输入框应已启用 ----
	await clickByText(page, "⚙"); // 再点一次关设置
	await sleep(800);
	const after = await page.evaluate(() => {
		const i = document.querySelector('input[maxlength="500"]');
		return { disabled: i?.disabled, footer: document.body.innerText };
	});
	check("接入后输入框启用", after.disabled === false);
	check("无限畅聊标识", after.footer.includes("无限畅聊"));

	const stored = await page.evaluate(() => localStorage.getItem("wlist-pet-own"));
	check("Key 只存本机浏览器", !!stored && stored.includes("127.0.0.1:8787") && stored.includes("mock-mini"), stored || "(空)");

	// ---- 7. 发消息 → mock 直连回复 ----
	chatInput = await page.$('input[maxlength="500"]');
	await chatInput.type("你好呀守盘助手");
	await page.evaluate(() => {
		const i = document.querySelector('input[maxlength="500"]');
		i.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	await sleep(3500);
	const chatText = await page.evaluate(() => document.body.innerText);
	check("收到 mock 直连回复", chatText.includes("mock-chat"), (chatText.match(/喵~[^\n]{0,60}/) || [""])[0]);

	console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
	process.exitCode = failures === 0 ? 0 : 1;
} finally {
	await browser.close();
}
