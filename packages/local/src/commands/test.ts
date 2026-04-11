import { execSync } from "child_process";

export async function testCommand(): Promise<void> {
  const chalk = (await import("chalk")).default;
  console.log(chalk.bold("\nCI Local Pro — Memory Quality Test (AMB)\n"));

  // Check if AMB is available
  try {
    execSync("npx agent-memory-benchmark --version", {
      stdio: "pipe",
      timeout: 15000,
    });
  } catch {
    console.log(chalk.yellow("  Agent Memory Benchmark (AMB) not found."));
    console.log();
    console.log("  Install with:");
    console.log(chalk.cyan("    npm i -g agent-memory-benchmark"));
    console.log();
    console.log(
      chalk.dim(
        "  AMB tests your memory system's retrieval quality across recall, temporal, and dedup categories."
      )
    );
    return;
  }

  // Run AMB
  console.log("  Running AMB against CI Local...\n");

  try {
    const output = execSync(
      "npx agent-memory-benchmark --provider central-intelligence-local --db-path ~/.central-intelligence/memories.db --format json",
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 300000, // 5 minute timeout
        encoding: "utf-8",
      }
    );

    // Try to parse JSON output
    try {
      const results = JSON.parse(output);
      console.log(chalk.bold("  AMB Results:"));

      if (results.categories) {
        for (const [category, score] of Object.entries(results.categories)) {
          const pct = typeof score === "number" ? Math.round(score * 100) : score;
          const color =
            typeof pct === "number" && pct >= 80
              ? chalk.green
              : typeof pct === "number" && pct >= 60
              ? chalk.yellow
              : chalk.red;
          console.log(`    ${category}: ${color(`${pct}%`)}`);
        }
      }

      if (results.composite !== undefined) {
        const composite = Math.round(results.composite * 100);
        const color = composite >= 80 ? chalk.green : composite >= 60 ? chalk.yellow : chalk.red;
        console.log();
        console.log(chalk.bold(`  Composite Score: ${color(`${composite}%`)}`));
      }
    } catch {
      // Not JSON, print raw output
      console.log(output);
    }
  } catch (err: any) {
    if (err.status) {
      console.log(chalk.red(`  AMB exited with code ${err.status}`));
      if (err.stdout) console.log(err.stdout.toString());
      if (err.stderr) console.log(chalk.dim(err.stderr.toString()));
    } else {
      console.log(chalk.red(`  AMB failed: ${err.message}`));
    }
  }

  console.log();
}
