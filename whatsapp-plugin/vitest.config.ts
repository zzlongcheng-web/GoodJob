import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    // 生产默认禁止删除WhatsApp账号（会级联清空聊天记录）。测试夹具需要清理账号，所以只在测试环境打开；
    // 默认禁删的行为由 tests/account-delete-guard.test.ts 单独验证。
    env: { PLUGIN_ALLOW_ACCOUNT_DELETE: "true" }
  }
});

