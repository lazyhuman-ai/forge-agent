#!/usr/bin/env python3
import os
import pty
import select
import signal
import sys
import termios
import tty


def main():
    if len(sys.argv) < 3:
        print("usage: pty-bridge.py <cwd> <shell> [args...]", file=sys.stderr)
        sys.exit(2)

    cwd = sys.argv[1]
    shell = sys.argv[2]
    args = [shell] + sys.argv[3:]
    pid, fd = pty.fork()

    if pid == 0:
        os.chdir(cwd)
        os.execvpe(shell, args, os.environ)

    old_attrs = None
    try:
        if sys.stdin.isatty():
            old_attrs = termios.tcgetattr(sys.stdin.fileno())
            tty.setraw(sys.stdin.fileno())

        while True:
            readable, _, _ = select.select([sys.stdin.fileno(), fd], [], [])
            if fd in readable:
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
            if sys.stdin.fileno() in readable:
                data = os.read(sys.stdin.fileno(), 4096)
                if not data:
                    break
                os.write(fd, data)
    finally:
        if old_attrs is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old_attrs)
        try:
            _, status = os.waitpid(pid, os.WNOHANG)
            if status == 0:
                os.kill(pid, signal.SIGTERM)
                _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
        except OSError:
            status = 1
        if os.WIFEXITED(status):
            sys.exit(os.WEXITSTATUS(status))
        if os.WIFSIGNALED(status):
            sys.exit(128 + os.WTERMSIG(status))
        sys.exit(0)


if __name__ == "__main__":
    main()
