"""Player spike: run a suite in Microsoft Edge with a throwaway profile and collect the results.

  python run_tests.py --mode headless|window --suite seq|seek --tag NAME [--query "k=v&k=v"] [--timeout 600] [--cap-mb 4]

Starts server.py, opens Edge on index.html?suite=..., waits for results/<tag>_<suite>_done.json,
then closes Edge (whole process tree) and the server, and deletes the temporary profile.
"""
import argparse, os, shutil, subprocess, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 8765


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["headless", "window"], default="headless")
    ap.add_argument("--suite", choices=["seq", "seek"], required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--query", default="")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--extra", default="", help="extra Edge flags, space separated")
    ap.add_argument("--cap-mb", default="0", help="server: cap open-ended range responses (MB, 0 = off)")
    ap.add_argument("--media-cache", default="no-store", help="server: Cache-Control for media responses")
    a = ap.parse_args()

    done = os.path.join(HERE, "results", f"{a.tag}_{a.suite}_done.json")
    if os.path.exists(done):
        os.remove(done)
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    server = subprocess.Popen([sys.executable, os.path.join(HERE, "server.py"), str(PORT), "--cap-mb", a.cap_mb, "--media-cache", a.media_cache,
                               "--log", os.path.join(HERE, "results", f"{a.tag}_{a.suite}_server.log")])
    time.sleep(1)
    profile = tempfile.mkdtemp(prefix="roughcut-edge-")
    url = f"http://127.0.0.1:{PORT}/index.html?suite={a.suite}&tag={a.tag}" + (f"&{a.query}" if a.query else "")
    flags = [f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
             "--autoplay-policy=no-user-gesture-required",
             "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
             "--disable-background-timer-throttling", "--disable-features=msEdgeSidebarV2,EdgeCollections",
             "--window-size=1280,900", "--window-position=40,40"]
    if a.mode == "headless":
        flags.append("--headless=new")
    flags += [f for f in a.extra.split() if f]
    edge = subprocess.Popen([EDGE, *flags, url])
    t0 = time.time()
    ok = False
    try:
        while time.time() - t0 < a.timeout:
            if os.path.exists(done):
                ok = True
                break
            if server.poll() is not None:
                print("server exited early")
                break
            time.sleep(1)
    finally:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(edge.pid)], capture_output=True)
        # Edge can hand off to a broker process; kill anything still using our temp profile.
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
                        f"Where-Object {{ $_.CommandLine -like '*{os.path.basename(profile)}*' }} | "
                        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
                       capture_output=True)
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/quit", timeout=3)
        except Exception:
            pass
        server.wait(timeout=10)
        time.sleep(1)
        shutil.rmtree(profile, ignore_errors=True)
    load = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).LoadPercentage"],
                          capture_output=True, text=True).stdout.strip()
    print("finished" if ok else "TIMEOUT", f"in {time.time() - t0:.0f}s; CPU load right after: {load}%")
    if ok:
        print(open(done).read())


if __name__ == "__main__":
    main()
