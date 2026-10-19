#!/bin/sh
set -e

su -s /bin/sh app -c '/usr/local/bin/api-server --port 8080 --workers 4 >/dev/null 2>&1 &'
su -s /bin/sh app -c '/usr/local/bin/queue-worker --concurrency 8 >/dev/null 2>&1 &'
su -s /bin/sh app -c '/usr/local/bin/log-shipper --tail /var/log/app >/dev/null 2>&1 &'
su -s /bin/sh deploy -c '/usr/local/bin/report-builder >/dev/null 2>&1 &'
/usr/local/bin/metrics-agent --interval 15s >/dev/null 2>&1 &

exec /usr/sbin/sshd -D -e
