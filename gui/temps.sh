#!/usr/bin/env bash
# Host temperature, and the two things on this box that cook it: SwiftShader and an LLM server.
#
#   bash gui/temps.sh            # one reading
#   bash gui/temps.sh --watch    # keep reading; print a line when the peak moves >2 C
#
# The wall's WebGL runs on the CPU here. ONE leftover headless Chrome on a render page is a full
# core of SwiftShader for as long as nobody notices, and a leaked gpu-process is what took this
# box over 100 C. Watch this while running gates, not after.
set -u
WATCH=0; EVERY="${2:-15}"
[ "${1:-}" = "--watch" ] && WATCH=1

# Note: this agent runs inside an unprivileged LXC with no hwmon and no lm-sensors, so it can only
# see load. The CPU package temperature is read on the host (ADV-DT01, 13700K) - the load figure
# here is the proxy: sustained 100% across all cores with a chrome process at the top of the list
# IS the symptom the user reports.
cpu_temp() {
  if command -v sensors >/dev/null 2>&1; then
    sensors 2>/dev/null | awk '
      /Package id 0|Tctl|Tdie/ {
        for (i = 1; i <= NF; i++) {
          t = $i; gsub(/\xc2\xb0/, "", t)          # ° as two UTF-8 bytes
          if (t ~ /^\+[0-9.]+C$/) { gsub(/[+C]/, "", t); print t; exit }
        }
      }'
    return
  fi
  # No lm-sensors: ask each CPU hwmon probe for its hottest input.
  for h in /sys/class/hwmon/hwmon*; do
    case "$(cat "$h/name" 2>/dev/null)" in
      coretemp|k10temp|zenpower|cpu_thermal|acpitz) ;;
      *) continue ;;
    esac
    for f in "$h"/temp*_input; do
      [ -r "$f" ] && echo $(( $(cat "$f") / 1000 ))
    done
  done 2>/dev/null | sort -n | tail -1
}

read_budget() {
  local num cpu chrome llm
  num=$(nproc)
  # %Cpu(s) idle from /proc/stat over 1 s: a true instantaneous figure, where ps's pcpu is lifetime.
  # (trailing fields: irq softirq steal guest guest_nice - one 'cpu ' line, six spaces max)
  set -- $(grep -m1 '^cpu ' /proc/stat)
  a1=$2; b1=$3; c1=$4; d1=$5; e1=$6; f1=$7; g1=$8; i1=${9:-0}
  sleep 1
  set -- $(grep -m1 '^cpu ' /proc/stat)
  a2=$2; b2=$3; c2=$4; d2=$5; e2=$6; f2=$7; g2=$8; i2=${9:-0}
  cpu=$(awk -v t1=$((a1+b1+c1+d1+e1+f1+g1+i1)) -v i1=$((d1+i1)) \
            -v t2=$((a2+b2+c2+d2+e2+f2+g2+i2)) -v i2=$((d2+i2)) \
       'BEGIN{ dt=t2-t1; if (dt<=0) { print "?"; exit } printf "%.0f", 100*(1-(i2-i1)/dt) }')
  chrome=$(ps -eo pcpu,comm --no-headers | awk '$2 ~ /^(chrome|chromium|headless_s)/ { s += $1 } END { printf "%.0f", s + 0 }')
  llm=$(ps -eo pcpu,comm --no-headers | awk '$2 ~ /llama|ollama|vllm/ { s += $1 } END { printf "%.0f", s + 0 }')
  printf 'temp=%sC cpu=%s%% (of %s cores) chrome=%s%% llm=%s%%' "${TEMP:-?}" "${cpu:-?}" "$num" "$chrome" "$llm"
}

report() {
  TEMP=$(cpu_temp)
  read_budget
  if [ -n "${TEMP:-}" ] && [ "${TEMP%%.*}" -ge 95 ] 2>/dev/null; then
    echo "  OVER 95C - burning; the top burners:"
    ps -eo pid:1,pcpu:1,comm --sort=-pcpu | head -5 | sed 's/^/    /'
    echo "  leaked browsers: bash gui/sweep-orphans.sh"
  fi
}

report
[ "$WATCH" -eq 1 ] || exit 0

last=${TEMP%%.*}; last=${last:-0}
while sleep "$EVERY"; do
  report >/dev/null
  now=${TEMP%%.*}; now=${now:-$last}
  if [ "$now" -ge $((last + 2)) ] || [ "$now" -le $((last - 2)) ]; then
    echo "$(date +%H:%M:%S) $(report)"
    last=$now
  fi
done
