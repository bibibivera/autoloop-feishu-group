// 飞书群通道：Agent Autoloop 的第三方插件
// https://github.com/bibibivera/autoloop-feishu-group
//
// 在 Autoloop 内置飞书通道的基础上加了这些：
//   1. 卡片发到一个群里，大家都看得到；只有 rules.json 里 answerers 写的人点按钮才算数（中台核对）。
//   2. 群里谁都可以 @ 机器人（或本人私聊它），说的话变成一条事件交给中台。
//      同一个话题 = 同一个事项：不管谁在话题里 @ 它，规则写了 "resume": true 就接着同一段 Agent 对话。
//   3. Agent 回答时交一个 notice（fyi），标题写「回复 om_xxx」，这里就把正文回复到那个话题里。
//   4. 本人说「记住：……」，原话加日期追加到知识库文件，不叫 Agent；别人说不记。
//   5. 不接别的机器人的消息，免得机器人之间来回对话。
//
// 安装：agent-autoloop add https://github.com/bibibivera/autoloop-feishu-group
// 配置见 README.md。
import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

type Card = {
  id: number;
  version: number;
  ref: string | null;
  kind: "ask" | "notice";
  state: "open" | "decided" | "done" | "closed";
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
  rule?: string | null;
};
type Context = {
  hub: {
    nextCard(wait: number): Promise<{ card: Card | null }>;
    delivered(card: number, version: number, ref: string | null): Promise<unknown>;
    failed(card: number, version: number, error: string): Promise<unknown>;
    answer(card: number, given: { choice?: number; by?: string; ref?: string; text?: string }): Promise<{ changed?: boolean }>;
  };
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};

const REPLY = /^回复\s*(om_[A-Za-z0-9_]+)\s*/;

function safeJson(text: unknown): any {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function outcomeOf(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return `已选「${chosen}」，正在处理。`;
  if (card.state === "done") return `已选「${chosen}」。${card.result ? `结果：${card.result}` : "已处理。"}`;
  if (card.state === "closed" && card.kind === "ask") return `不用决定了：${card.result ?? ""}`;
  return card.state === "closed" && card.result ? card.result : null;
}

/** 卡片：开着的时候是选项按钮，处理完换成结果。 */
function render(card: Card) {
  const outcome = outcomeOf(card);
  const option = (label: string, index: number) => ({
    tag: "button",
    type: index === card.recommend ? "primary" : "default",
    text: { tag: "plain_text", content: label },
    behaviors: [{ type: "callback", value: { card: card.id, choice: index } }],
  });
  const source = card.rule && card.rule !== card.title ? [{ tag: "markdown", content: `<font color='grey'>来源：${card.rule}</font>` }] : [];
  const buttons = card.state === "open" && card.options.length ? [{ tag: "column_set", flex_mode: "flow", columns: card.options.map((label, index) => ({ tag: "column", width: "auto", elements: [option(label, index)] })) }] : [];
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: {
      title: { tag: "plain_text", content: card.title },
      template: card.state === "open" ? (card.kind === "ask" ? "orange" : "blue") : card.state === "done" ? "green" : "grey",
    },
    body: {
      elements: [
        ...source,
        ...(card.text ? [{ tag: "markdown", content: card.text }] : []),
        ...buttons,
        ...(card.state !== "open" && outcome ? [{ tag: "markdown", content: `**${outcome}**` }] : []),
      ],
    },
  };
}

/** 去掉 @机器人 的占位符，剩下的就是说的话。 */
function wordsOf(event: any) {
  let text = String(event.content ?? "");
  const parsed = safeJson(text);
  if (parsed && typeof parsed.text === "string") text = parsed.text;
  for (const m of Array.isArray(event.mentions) ? event.mentions : []) {
    if (m?.key) text = text.split(m.key).join("");
    if (m?.name) text = text.split(`@${m.name}`).join("");
  }
  return text.replace(/@_user_\d+/g, "").trim();
}

export default async function feishuGroup({ hub, options, log, signal }: Context) {
  const program = (options.lark as string | undefined) ?? "lark-cli";
  const chat = options.chat as string;
  const owner = options.user as string;
  const askers = Array.isArray(options.askers) ? (options.askers as string[]) : null;
  if (!chat?.startsWith("oc_")) throw new Error("飞书群通道要在 config.json 写 chat（oc_ 开头的群号）");
  if (!owner?.startsWith("ou_")) throw new Error("飞书群通道要在 config.json 写 user（本人的 open_id）");

  const lark = (args: string[], input?: string) =>
    new Promise<any>((resolve, reject) => {
      const child = execFile(program, args, { encoding: "utf8", timeout: 60_000, signal, shell: process.platform === "win32" && !program.endsWith(".exe") }, (error, stdout) => {
        if (error) return reject(error);
        try {
          const out = JSON.parse(stdout);
          if (out.ok === false || out.error) return reject(new Error(JSON.stringify(out.error ?? out).slice(0, 300)));
          resolve(out);
        } catch {
          reject(new Error("lark-cli 没返回 JSON：" + String(stdout).slice(0, 200)));
        }
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });

  const sendCard = async (key: string, content: string) =>
    (await lark(["im", "+messages-send", "--chat-id", chat, "--as", "bot", "--msg-type", "interactive", "--idempotency-key", key, "--content", content])).data.message_id as string;
  const updateCard = (ref: string, content: string) =>
    lark(["im", "messages", "patch", "--message-id", ref, "--as", "bot", "--data", "-"], JSON.stringify({ content }));
  const replyText = async (to: string, markdown: string, key: string) =>
    (await lark(["im", "+messages-reply", "--message-id", to, "--reply-in-thread", "--as", "bot", "--idempotency-key", key, "--markdown", markdown])).data.message_id as string;

  // ---------- 发卡片、发回复 ----------
  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(50));
      } catch (error) {
        log(`连不上中台：${error}`);
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      if (!card) continue;
      try {
        const reply = card.kind === "notice" ? REPLY.exec(card.title) : null;
        if (reply) {
          // 回答：回复到原话题里，不发卡片。发过一次就不再改。
          const ref = card.ref ?? (await replyText(reply[1], card.text || card.title.replace(REPLY, ""), `aa-reply-${card.id}`));
          await hub.delivered(card.id, card.version, ref);
          continue;
        }
        const content = JSON.stringify(render(card));
        let ref = card.ref;
        if (ref) {
          try {
            await updateCard(ref, content);
          } catch (error) {
            if (card.state === "open") throw error;
            log(`卡片 ${card.id} 改不了，重发一张：${error}`);
            ref = await sendCard(`aa-card-${card.id}-v${card.version}`, content);
          }
        } else ref = await sendCard(`aa-card-${card.id}`, content);
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`卡片 ${card.id} 没发出去：${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  // ---------- 按钮：只认 answerers，中台核对 ----------
  async function clicked(line: string) {
    const event = JSON.parse(line);
    const value = safeJson(event.action_value);
    if (!Number.isInteger(value?.card) || !Number.isInteger(value?.choice)) return;
    const answer = await hub.answer(value.card, { choice: value.choice, by: event.operator_id, ref: event.message_id });
    log(`卡片 ${value.card}：${event.operator_id} 点了第 ${value.choice + 1} 项，${answer.changed ? "算数" : "不算（已处理过或不是回答人）"}`);
  }

  // ---------- 群里 @ 它 ----------
  const threads = new Set<string>(); // 机器人参与过的话题：话题里接着说不用再 @
  async function said(line: string) {
    const event = JSON.parse(line);
    if (event.sender_type && event.sender_type !== "user") return; // 不接别的机器人的话，免得机器人之间来回对话
    const p2p = event.chat_type === "p2p";
    if (p2p ? event.sender_id !== owner : event.chat_id !== chat) return;
    const root = event.root_id || event.message_id;
    const mentioned = Array.isArray(event.mentions) && event.mentions.length > 0;
    if (!p2p && !mentioned && !threads.has(root)) return;
    if (!p2p && askers && !askers.includes(event.sender_id)) return;
    const words = wordsOf(event);
    if (!words) return;
    threads.add(root);

    const remember = /^记住[：:]\s*(.+)$/s.exec(words);
    if (remember && event.sender_id !== owner) {
      // 大群里谁都能问，但规矩只有本人能定
      await replyText(root, "规矩只有老板能让我记，我先不记这条。", `aa-mem-${event.message_id}`);
      return;
    }
    if (remember && options.memory) {
      appendFileSync(String(options.memory), `\n- ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}：${remember[1].trim()}`);
      await replyText(root, "记下了，以后干活前都会先读这条。", `aa-mem-${event.message_id}`);
      return;
    }

    const response = await fetch(`${options.hub}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.sourceKey}` },
      body: JSON.stringify({
        id: event.message_id,
        type: "feishu.mention",
        subject: root, // 同一个话题 = 同一个事项，规则写 resume 就接着同一段对话
        summary: words.slice(0, 200),
        detail: JSON.stringify({ 说话人: event.sender_id, 是不是本人: event.sender_id === owner, 原话: words, 话题: root }).slice(0, 4000),
      }),
    });
    if (!response.ok) throw new Error(`中台没收下：${response.status} ${await response.text()}`);
    log(`收到 ${event.sender_id} 的提问，话题 ${root}`);
  }

  // ---------- 一直听着：断了 10 秒后重连 ----------
  async function consume(key: string, handle: (line: string) => Promise<void>) {
    while (!signal.aborted) {
      // stdin 保持打开：lark-cli 在 stdin 关掉时会结束监听
      const child = spawn(program, ["event", "consume", key, "--as", "bot"], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" && !program.endsWith(".exe") });
      child.on("error", (error) => log(`${key} 没跑起来：${error}`));
      const stop = () => child.kill();
      signal.addEventListener("abort", stop);
      let buffered = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        let at;
        while ((at = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, at).trim();
          buffered = buffered.slice(at + 1);
          if (line) handle(line).catch((error) => log(`${key} 处理出错：${error}`));
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => chunk.split("\n").filter(Boolean).forEach((l) => log(`[${key}] ${l}`)));
      await new Promise((resolve) => child.on("close", resolve));
      signal.removeEventListener("abort", stop);
      if (!signal.aborted) {
        log(`${key} 断了，10 秒后重连`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  await Promise.all([deliver(), consume("card.action.trigger", clicked), consume("im.message.receive_v1", said)]);
}
