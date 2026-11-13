#include "trust.h"
#include <unistd.h>
int main(int argc, char **argv) {
  (void)argv;
  alarm(30);
  return argc == 1 ? general_preflight_reply(3) : 64;
}
