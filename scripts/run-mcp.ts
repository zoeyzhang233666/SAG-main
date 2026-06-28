process.env.SAG_LOG_STDERR = "true";

const { startMcpServer } = await import("../src/mcp/server.js");

startMcpServer().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
