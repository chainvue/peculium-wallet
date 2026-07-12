#!/usr/bin/env node
// Single bin: `peculium mcp` starts the stdio MCP server; every other
// subcommand is the operator CLI. stdout belongs to the MCP protocol —
// human/diagnostic output goes to stderr.
//
// Etappe 0: stub. Dispatch arrives with E4 (mcp) and E5 (CLI).

process.stderr.write(
  "peculium: not implemented yet (Etappe 0 skeleton). See DESIGN.md.\n",
);
process.exit(1);
