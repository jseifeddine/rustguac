# Throwaway SSH host for the screenshot environment. It answers for every
# demo host name (app-01.example.internal, bastion.example.com, ...) through
# network aliases, and runs a few idle placeholder services so that `htop`
# has something to show.
ARG ALPINE_VERSION=3.20
FROM alpine:${ALPINE_VERSION}

RUN apk add --no-cache bash htop openssh-server procps \
    && ssh-keygen -A \
    && adduser -D -s /bin/bash deploy \
    && adduser -D -s /sbin/nologin app \
    && echo 'deploy:demo-password' | chpasswd \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?MaxStartups.*/MaxStartups 10:30:100/' /etc/ssh/sshd_config

COPY service.sh /usr/local/lib/demo/service.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /usr/local/lib/demo/service.sh /entrypoint.sh \
    && for s in api-server queue-worker log-shipper report-builder metrics-agent; do \
         ln -s /usr/local/lib/demo/service.sh "/usr/local/bin/$s"; \
       done

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
