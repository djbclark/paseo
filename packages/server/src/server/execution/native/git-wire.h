/* Private finite Git observer protocol. Source/build evidence, never permission. */
#ifndef PASEO_GIT_WIRE_H
#define PASEO_GIT_WIRE_H
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int git_nonce(const char *text) {
  if (!text || strlen(text) != 64) return 0;
  for (size_t i = 0; i < 64; i++)
    if (!((text[i] >= '0' && text[i] <= '9') ||
          (text[i] >= 'a' && text[i] <= 'f'))) return 0;
  return 1;
}

/* A dead controller must not deliver SIGPIPE to the actual Git operation. */
static int git_write(int fd, const char *message) {
  sigset_t block, previous, pending;
  sigemptyset(&block);
  sigaddset(&block, SIGPIPE);
  if (sigprocmask(SIG_BLOCK, &block, &previous) < 0) return 0;
  sigpending(&pending);
  int had_pending = sigismember(&pending, SIGPIPE);
  int flags = fcntl(fd, F_GETFL);
  int ok = flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) >= 0;
  size_t length = strlen(message);
  if (ok) ok = write(fd, message, length) == (ssize_t)length;
  if (flags >= 0) (void)fcntl(fd, F_SETFL, flags);
  if (!had_pending) {
    struct timespec zero = {0, 0};
    while (sigtimedwait(&block, NULL, &zero) < 0 && errno == EINTR) {}
  }
  (void)sigprocmask(SIG_SETMASK, &previous, NULL);
  return ok;
}

/* Bounded control wait only: expiry resumes work, never settles eligibility. */
static int git_line(int fd, char *buffer, size_t capacity, int milliseconds) {
  struct timespec start, now;
  if (clock_gettime(CLOCK_MONOTONIC, &start) < 0) return 0;
  size_t used = 0;
  while (used + 1 < capacity) {
    if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return 0;
    long elapsed = (now.tv_sec - start.tv_sec) * 1000 +
                   (now.tv_nsec - start.tv_nsec) / 1000000;
    if (elapsed >= milliseconds) return 0;
    struct pollfd item = {fd, POLLIN, 0};
    int result = poll(&item, 1, milliseconds - (int)elapsed);
    if (result < 0 && errno == EINTR) continue;
    if (result <= 0 || !(item.revents & POLLIN)) return 0;
    ssize_t count = read(fd, buffer + used, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count != 1) return 0;
    if (buffer[used++] == '\n') {
      buffer[used] = 0;
      return 1;
    }
  }
  return 0;
}
#endif
