/* One dedicated subreaper for precisely the two worktree-include Git calls.
 * FD 5 = protected native Git ELF; FD 6 = protected retained gate ELF.
 * FD 3/4 = original producer-owned observation/control endpoints. */
#include "git-wire.h"
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/syscall.h>

extern char **environ;
static volatile sig_atomic_t requested_signal;
static void request_signal(int signal_number) { requested_signal = signal_number; }

static int protected_elf(int fd) {
  struct stat info;
  unsigned char magic[4];
  return fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == 0 &&
         !(info.st_mode & 07222) && pread(fd, magic, 4, 0) == 4 &&
         memcmp(magic, "\177ELF", 4) == 0;
}

static int forward_request(pid_t child) {
  if (!requested_signal) return 1;
  int value = requested_signal;
  requested_signal = 0;
  return kill(child, value) == 0;
}

static void execute_git(const char *nonce, const char *operation, int observation, int control) {
  /* Move pipes above fixed descriptors before assigning, even if pipe2 selected
   * 7 or 8. Inherited producer control/observation endpoints never reach Git. */
  int ready = fcntl(observation, F_DUPFD_CLOEXEC, 20);
  int resume = fcntl(control, F_DUPFD_CLOEXEC, 20);
  if (ready < 0 || resume < 0 || dup2(ready, 7) < 0 || dup2(resume, 8) < 0) _exit(126);
  close(ready);
  close(resume);
  close(3);
  close(4);
  if (fcntl(5, F_SETFD, FD_CLOEXEC) < 0 || fcntl(6, F_SETFD, 0) < 0 ||
      setenv("PASEO_GIT_GATE_NONCE", nonce, 1) < 0 ||
      setenv("LD_PRELOAD", "/proc/self/fd/6", 1) < 0) _exit(126);
  char *ls[] = {"git", "ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z", NULL};
  char *ignore[] = {"git", "check-ignore", "--stdin", "-z", NULL};
  syscall(SYS_execveat, 5, "", strcmp(operation, "ls-files") == 0 ? ls : ignore,
          environ, AT_EMPTY_PATH);
  _exit(126);
}

static int observe_gate(const char *nonce, pid_t child, int ready, int control) {
  char record[192], expected[192], resume[192];
  snprintf(expected, sizeof expected, "ready %s %ld\n", nonce, (long)child);
  int ok = git_line(ready, record, sizeof record, 4000) && !strcmp(record, expected);
  if (ok) ok = git_write(3, record);
  snprintf(resume, sizeof resume, "resume %s\n", nonce);
  if (ok) ok = git_line(4, record, sizeof record, 3000) && !strcmp(record, resume);
  /* A failed proof resumes the original invocation once, without an ACK. */
  if (!ok) snprintf(resume, sizeof resume, "continue %s\n", nonce);
  if (!git_write(control, resume)) ok = 0;
  snprintf(expected, sizeof expected, "gate %s accepted\n", nonce);
  if (!git_line(ready, record, sizeof record, 2000) || strcmp(record, expected)) ok = 0;
  close(control);
  close(ready);
  (void)forward_request(child);
  return ok;
}

int main(int argc, char **argv) {
  if (argc != 3 || !git_nonce(argv[1]) ||
      (strcmp(argv[2], "ls-files") && strcmp(argv[2], "check-ignore")) ||
      !protected_elf(5) || !protected_elf(6)) return 126;
  int subreaper = 0;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) < 0 ||
      prctl(PR_GET_CHILD_SUBREAPER, &subreaper) < 0 || subreaper != 1) return 126;
  struct sigaction action = {0};
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGCHLD, &action, NULL) < 0) return 126;
  action.sa_handler = request_signal;
  const int signals[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT};
  for (size_t i = 0; i < sizeof signals / sizeof signals[0]; i++)
    if (sigaction(signals[i], &action, NULL) < 0) return 126;
  int ready[2], control[2];
  if (pipe2(ready, O_CLOEXEC) < 0 || pipe2(control, O_CLOEXEC) < 0) return 126;
  pid_t child = fork();
  if (child < 0) return 126;
  if (child == 0) execute_git(argv[1], argv[2], ready[1], control[0]);
  close(ready[1]);
  close(control[0]);
  char record[256];
  snprintf(record, sizeof record, "spawn %s %ld\n", argv[1], (long)child);
  int observed = git_write(3, record);
  observed = observe_gate(argv[1], child, ready[0], control[1]) && observed;
  int leader_status = 0, have_leader = 0, unexpected = 0, drained = 0;
  for (;;) {
    if (!have_leader && !forward_request(child)) observed = 0;
    int status;
    pid_t result = waitpid(-1, &status, __WALL);
    if (result < 0) {
      if (errno == EINTR) continue;
      drained = errno == ECHILD;
      break;
    }
    if (result == child) {
      leader_status = status;
      have_leader = 1;
      snprintf(record, sizeof record, "leader %s %ld %d %d\n", argv[1], (long)child,
               WIFEXITED(status) ? WEXITSTATUS(status) : -1,
               WIFSIGNALED(status) ? WTERMSIG(status) : 0);
      if (!git_write(3, record)) observed = 0;
    } else {
      /* Adoption proves lifetime but does not grant image provenance. */
      unexpected = 1;
    }
  }
  int code = have_leader && WIFEXITED(leader_status) ? WEXITSTATUS(leader_status) : -1;
  int signal_number = have_leader && WIFSIGNALED(leader_status) ? WTERMSIG(leader_status) : 0;
  snprintf(record, sizeof record, "complete %s %ld %d %d %s\n", argv[1], (long)child,
           code, signal_number,
           observed && drained && have_leader && !unexpected ? "observed" : "unknown");
  (void)git_write(3, record);
  if (signal_number) {
    signal(signal_number, SIG_DFL);
    raise(signal_number);
    return 128 + signal_number;
  }
  return code >= 0 ? code : 126;
}
