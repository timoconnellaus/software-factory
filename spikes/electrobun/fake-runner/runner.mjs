// Stand-in for sf-runner, so supervision can be tested without pairing. Prints a heartbeat line
// as JSON every second; `crash` on stdin exits 1, SIGTERM exits cleanly.
let n = 0;
const beat = () => console.log(JSON.stringify({ kind: "heartbeat", n: n++, pid: process.pid, node: process.version }));
beat();
const t = setInterval(beat, 1000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
	if (d.trim() === "crash") {
		console.error("crashing on request");
		process.exit(1);
	}
});
process.on("SIGTERM", () => {
	clearInterval(t);
	console.log(JSON.stringify({ kind: "stopped" }));
	process.exit(0);
});
