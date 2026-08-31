// bash 静态越狱检测（Default 模式 best-effort 边界）纯函数测试。
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectWorkspaceEscape } from "../src/agent/tools/bash.ts";
import { WORKSPACE } from "./helpers.ts";

test("显式外部路径引用被拦截", () => {
	assert.equal(detectWorkspaceEscape("cat ../../secret.txt", WORKSPACE), "../../secret.txt");
	assert.equal(detectWorkspaceEscape("cd ..", WORKSPACE), "..");
	assert.equal(detectWorkspaceEscape("type E:\\Windows\\win.ini", WORKSPACE), "E:\\Windows\\win.ini");
	assert.equal(detectWorkspaceEscape("cat C:/x/y.txt", WORKSPACE), "C:/x/y.txt");
	assert.equal(detectWorkspaceEscape("cat /etc/passwd", WORKSPACE), "/etc/passwd");
	assert.equal(detectWorkspaceEscape("rm -rf /", WORKSPACE), "/");
	assert.equal(detectWorkspaceEscape("cp ~/.ssh/id_rsa .", WORKSPACE), "~/.ssh/id_rsa");
});

test("Workspace 内部路径与无关 token 放行", () => {
	assert.equal(detectWorkspaceEscape("python script.py", WORKSPACE), null);
	assert.equal(detectWorkspaceEscape("npm install", WORKSPACE), null);
	assert.equal(detectWorkspaceEscape("cat ./a.py", WORKSPACE), null);
	assert.equal(detectWorkspaceEscape("cat sub/dir/file.txt", WORKSPACE), null);
	assert.equal(detectWorkspaceEscape("git clone https://github.com/a/b repo", WORKSPACE), null);
	assert.equal(detectWorkspaceEscape("echo 'path/like' && git status", WORKSPACE), null);
});
