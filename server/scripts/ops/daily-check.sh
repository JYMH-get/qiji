#!/usr/bin/env bash
# Qiji 服务端每日状态巡检（在服务器上执行；本机用 `ssh qiji bash -s < 本文件` 远程跑）
# 只读：不写库、不重启容器、不改配置。输出带 [OK]/[WARN]/[FAIL] 前缀，便于快速扫读。
set -uo pipefail

ROOT=/opt/qiji
DATA=$ROOT/server/data
WARN=0; FAIL=0
ok(){   echo "[OK]   $*"; }
warn(){ echo "[WARN] $*"; WARN=$((WARN+1)); }
fail(){ echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
hr(){   echo; echo "── $* ──"; }

echo "Qiji 每日巡检  $(date '+%F %T %Z')  host=$(hostname)"

hr "1. 容器"
if docker ps --format '{{.Names}}' | grep -qx qiji-server; then
  ST=$(docker inspect qiji-server --format '{{.State.Status}}')
  RC=$(docker inspect qiji-server --format '{{.RestartCount}}')
  SINCE=$(docker inspect qiji-server --format '{{.State.StartedAt}}')
  ok "qiji-server $ST，启动于 $SINCE"
  [ "$RC" -gt 0 ] && warn "重启次数 RestartCount=$RC（非 0 说明曾崩溃自愈，查日志段）" || ok "重启次数 0"
else
  fail "qiji-server 容器不在运行"
fi

hr "2. 健康检查"
H=$(curl -s -m 8 http://127.0.0.1:8787/health)
echo "$H" | grep -q '"ok":true' && ok "/health $H" || fail "/health 异常：$H"

hr "3. 主机资源"
read -r _ TOT USED FREE PCT _ <<<"$(df -h / | tail -1)"
echo "磁盘 /  总 $TOT 用 $USED 余 $FREE（$PCT）"
P=${PCT%\%}
[ "$P" -ge 90 ] && fail "磁盘使用率 $PCT ≥90%" || { [ "$P" -ge 75 ] && warn "磁盘使用率 $PCT ≥75%" || ok "磁盘充裕"; }
free -h | sed -n '1,2p'
MFREE=$(free -m | awk '/^Mem:/{print $7}')
[ "$MFREE" -lt 300 ] && warn "可用内存仅 ${MFREE}MB" || ok "可用内存 ${MFREE}MB"
echo "负载$(uptime | sed 's/.*load average/  load average/')"

hr "4. 数据与库"
du -sh $DATA 2>/dev/null | awk '{print "data 目录 " $1}'
DBB=$(stat -c %s $DATA/qiji.db 2>/dev/null || echo 0)
WALB=$(stat -c %s $DATA/qiji.db-wal 2>/dev/null || echo 0)
printf 'qiji.db %s   WAL %s\n' "$(numfmt --to=iec $DBB)" "$(numfmt --to=iec $WALB)"
if   [ "$WALB" -gt 524288000 ]; then fail "WAL >500MB —— checkpoint 没落地，重启恢复会很慢，需处理"
elif [ "$WALB" -gt 104857600 ]; then warn "WAL >100MB —— 观察是否持续增长"
else ok "WAL 正常"; fi
for f in tasks.json users.json redeem-codes.json; do
  [ -f "$DATA/$f" ] && printf '%-18s %8s  改于 %s\n' "$f" "$(du -h $DATA/$f | cut -f1)" "$(stat -c %y $DATA/$f | cut -d. -f1)"
done
BK=$(ls -1 $DATA/qiji.db.bak-* 2>/dev/null | wc -l)
[ "$BK" -gt 0 ] && ok "库备份 $BK 份（最新 $(ls -t $DATA/qiji.db.bak-* 2>/dev/null | head -1 | xargs -r basename)）" || warn "没有 qiji.db.bak-* 备份"

hr "5. 任务队列积压"
docker exec qiji-server node -e '
const fs=require("fs");let d;try{d=JSON.parse(fs.readFileSync("/app/server/data/tasks.json","utf8"))}catch(e){console.log("[WARN] tasks.json 读不动:",e.message);process.exit(0)}
const t=d.tasks||[],now=Date.now(),H=3600e3;
const live=t.filter(x=>x.awaitingReal&&!x.doneStatus)   // 同 tasks.ts 的 isPending;
const old=live.filter(x=>now-(x.submittedAt||now)>6*H);
console.log(`任务表 ${t.length} 条，在途 ${live.length} 条`);
if(old.length)console.log(`[WARN] 其中 ${old.length} 条在途超 6 小时（疑似僵尸，最老 ${Math.round((now-Math.min(...old.map(x=>x.submittedAt)))/H)}h）`);
else console.log("[OK]   无超 6 小时的在途任务");
const by={};for(const x of live)by[x.resume?.protocol||"?"]=(by[x.resume?.protocol||"?"]||0)+1;
if(live.length)console.log("在途分布:",JSON.stringify(by));
' 2>&1 | sed 's/^/  /'

hr "6. 容器日志"
LP=$(docker inspect qiji-server --format '{{.LogPath}}')
LB=$(stat -c %s "$LP" 2>/dev/null || echo 0)
echo "日志文件 $(numfmt --to=iec $LB)"
if   [ "$LB" -gt 3221225472 ]; then fail "日志 >3G —— docker 未配轮转，白吃磁盘（compose 加 logging.max-size 后重建容器）"
elif [ "$LB" -gt 1073741824 ]; then warn "日志 >1G —— 建议配置轮转"
else ok "日志体积正常"; fi
# ⚠ 只读末尾 2 万行：日志文件几个 G 时 --since 会全量扫描（实测 320 万行、跑 2 分钟），tail 从文件尾读秒回
LOG=$(timeout 60 docker logs --tail 20000 qiji-server 2>&1)
EC=$(echo "$LOG" | grep -ciE 'error|unhandled|ECONNREFUSED|FATAL' || true)
echo "末 2 万行中命中 error 关键字 $EC 行"
if [ "$EC" -gt 500 ]; then warn "错误行偏多，抽样如下："; echo "$LOG" | grep -iE 'error|unhandled|FATAL' | tail -5 | sed 's/^/  /'
elif [ "$EC" -gt 0 ]; then ok "少量错误，抽样："; echo "$LOG" | grep -iE 'error|unhandled|FATAL' | tail -3 | sed 's/^/  /'
else ok "无错误行"; fi

hr "结论"
echo "WARN=$WARN  FAIL=$FAIL"
[ "$FAIL" -gt 0 ] && exit 2
[ "$WARN" -gt 0 ] && exit 1
exit 0
