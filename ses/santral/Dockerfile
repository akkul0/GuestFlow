# Santral: Netgsm'e (SIP) bağlanır, gelen aramayı ses asistanına verir (AudioSocket)
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends asterisk \
    && rm -rf /var/lib/apt/lists/*
COPY baslat.sh /baslat.sh
RUN chmod +x /baslat.sh
CMD ["/baslat.sh"]
