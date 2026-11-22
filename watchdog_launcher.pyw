"""Task Scheduler entry point for the Hermes Mobile watchdog.

Runs under pythonw.exe (GUI subsystem, no console), so the scheduled task never
shows a window.  It spawns watchdog.ps1 with CREATE_NO_WINDOW and exits at once.
"""
import os
import subprocess

BASE = os.path.dirname(os.path.abspath(__file__))
PS1 = os.path.join(BASE, "watchdog.ps1")

subprocess.Popen(
    [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", PS1,
    ],
    cwd=BASE,
    creationflags=0x08000000,          # CREATE_NO_WINDOW
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    close_fds=True,
)
