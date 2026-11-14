// node --test tests/channel.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeOf, mayApprove } from "../channel.ts";

const MAIN = "oc_main", BUY = "oc_buy";

test("群里聊出来的卡片回原话题，正文去掉话题那一行", () => {
  const r = routeOf({ text: "**发生了什么**：……\n话题：om_x100b60b628d7", rule: "群里问答" }, MAIN, { 群里问答: BUY });
  assert.deepEqual(r, { thread: "om_x100b60b628d7", chat: null, text: "**发生了什么**：……" });
});

test("定时规则的卡片按 routes 发到指定的群，没写的发默认群", () => {
  assert.equal(routeOf({ text: "x", rule: "断货巡检" }, MAIN, { 断货巡检: BUY }).chat, BUY);
  assert.equal(routeOf({ text: "x", rule: "广告巡检" }, MAIN, { 断货巡检: BUY }).chat, MAIN);
  assert.equal(routeOf({ text: "x", rule: null }, MAIN).chat, MAIN);
});

test("正文中间提到话题编号不算，只认最后一行", () => {
  const r = routeOf({ text: "话题：om_aaa 里说的那个词\n其他内容", rule: null }, MAIN);
  assert.equal(r.thread, null);
});

test("只有群主和群管理员能批", () => {
  const info = { owner_id: "ou_owner", user_manager_id_list: ["ou_admin"] };
  assert.equal(mayApprove(info, "ou_owner"), true);
  assert.equal(mayApprove(info, "ou_admin"), true);
  assert.equal(mayApprove(info, "ou_member"), false);
  assert.equal(mayApprove(null, "ou_owner"), false);
  assert.equal(mayApprove({ owner_id: "ou_owner" }, ""), false);
});
