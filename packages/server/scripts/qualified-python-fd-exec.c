/* Test-only Linux FD-exec fixture. No observer, admission or fallback. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int refusal(const char *phase, int error) {
  fprintf(stderr,"{\"kind\":\"python-fd-exec-refusal\",\"phase\":\"%s\",\"errno\":%d}\n",phase,error);
  return 126;
}
int main(int argc,char **argv) {
  char root[PATH_MAX], executable[PATH_MAX], probe[PATH_MAX], home[PATH_MAX+6];
  if(argc!=2 || argv[1][0]!='/' || !realpath(argv[1],root) || strcmp(root,argv[1]))
    return refusal("root",EINVAL);
  int flags=fcntl(5,F_GETFD);
  if(flags<0 || fcntl(5,F_SETFD,flags|FD_CLOEXEC)<0) return refusal("cloexec",errno);
  if((fcntl(5,F_GETFD)&FD_CLOEXEC)==0) return refusal("cloexec",EINVAL);
  struct stat info;
  if(fstat(5,&info)<0) return refusal("fstat",errno);
  if(!S_ISREG(info.st_mode) || info.st_nlink!=1 || (info.st_mode&07777)!=0555)
    return refusal("descriptor",EINVAL);
  if(snprintf(executable,sizeof executable,"%s/python/bin/python3",root)>=(int)sizeof executable ||
     snprintf(probe,sizeof probe,"%s/python/provenance/probe.py",root)>=(int)sizeof probe)
    return refusal("paths",ENAMETOOLONG);
  struct passwd *account=getpwuid(getuid());
  if(!account || !account->pw_dir || account->pw_dir[0]!='/') return refusal("account",EINVAL);
  for(const char *c=account->pw_dir;*c;c++)
    if(!((*c>='a'&&*c<='z')||(*c>='A'&&*c<='Z')||(*c>='0'&&*c<='9')||strchr("/._-",*c)))
      return refusal("account",EINVAL);
  if(snprintf(home,sizeof home,"HOME=%s",account->pw_dir)>=(int)sizeof home)
    return refusal("account",ENAMETOOLONG);
  char *environment[]={"PATH=/usr/bin:/bin","LANG=C","LC_ALL=C",home,NULL};
  char *arguments[]={executable,"-I","-S","-B",probe,NULL};
  if(fprintf(stderr,"{\"kind\":\"python-fd-exec-descriptor\",\"fd\":5,\"cloexec\":true,\"dev\":\"%ju\",\"ino\":\"%ju\",\"mode\":%u,\"size\":%jd,\"home\":\"%s\"}\n",
      (uintmax_t)info.st_dev,(uintmax_t)info.st_ino,(unsigned)(info.st_mode&07777),
      (intmax_t)info.st_size,account->pw_dir)<0 || fflush(stderr)) return 126;
  syscall(SYS_execveat,5,"",arguments,environment,AT_EMPTY_PATH);
  return refusal("execveat",errno);
}
