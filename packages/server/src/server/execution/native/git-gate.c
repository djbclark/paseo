/* Git-only retained post-exec gate. Loader/preinit closure must be trusted BEFORE
 * launch. This gate is corroborating observation, not a loader sandbox. */
#include "git-wire.h"
#include <stdio.h>
#include <stdlib.h>

__attribute__((constructor)) static void paseo_git_gate(void) {
  const char *nonce = getenv("PASEO_GIT_GATE_NONCE");
  if (!git_nonce(nonce)) return;
  char ready[192], request[192], expected[192];
  snprintf(ready, sizeof ready, "ready %s %ld\n", nonce, (long)getpid());
  snprintf(expected, sizeof expected, "resume %s\n", nonce);
  int accepted = git_write(7, ready) && git_line(8, request, sizeof request, 5000) &&
                 strcmp(request, expected) == 0;
  snprintf(ready, sizeof ready, "gate %s %s\n", nonce,
           accepted ? "accepted" : "unobserved");
  (void)git_write(7, ready);
  close(7);
  close(8);
  close(6);
  /* No signal, exit, rerun or cancellation on loss of the controller. */
  unsetenv("PASEO_GIT_GATE_NONCE");
  unsetenv("LD_PRELOAD");
}
