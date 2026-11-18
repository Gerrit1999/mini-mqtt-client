#!/usr/bin/env python3
"""Run a paced MQTT 3.1.1 round trip against a private Mosquitto process."""

import argparse
import asyncio
import json
import os
import shutil
import socket
import sys
import tempfile
import time
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path


HOST = "127.0.0.1"
TOPIC = "perf/round-trip"
PAYLOAD_BYTES = 128
READY = b"ready\n"
STOP = b"stop\n"
QUIET_SECONDS = 0.25


def payload(sequence):
    return f"{sequence:012d} ".ljust(PAYLOAD_BYTES, "x").encode("ascii") + b"\n"


@asynccontextmanager
async def managed_process(*command, **options):
    process = await asyncio.create_subprocess_exec(*command, **options)
    try:
        yield process
    finally:
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.communicate(), 2)
            except TimeoutError:
                if process.returncode is None:
                    process.kill()
                await process.communicate()


async def wait_for_broker(broker, port):
    async with asyncio.timeout(5):
        while broker.returncode is None:
            try:
                _, writer = await asyncio.open_connection(HOST, port)
            except ConnectionRefusedError:
                await asyncio.sleep(0.025)
            else:
                writer.close()
                await writer.wait_closed()
                return
    raise RuntimeError(f"Mosquitto exited with code {broker.returncode}")


async def wait_for_subscription(writer, reader):
    # An echoed probe confirms subscription and delivery before timing begins.
    async with asyncio.timeout(5):
        while True:
            writer.write(READY)
            await writer.drain()
            try:
                line = await asyncio.wait_for(reader.readline(), 0.05)
            except TimeoutError:
                continue
            if line != READY:
                raise RuntimeError("Subscriber exited or returned an invalid readiness probe")
            return


async def publish(publisher, rate, count, start):
    writer = publisher.stdin
    batch_size = max(1, min(128, rate // 100))
    for first in range(1, count + 1, batch_size):
        end = min(first + batch_size - 1, count)
        await asyncio.sleep(max(0, start + end / rate - time.monotonic()))
        writer.write(b"".join(payload(seq) for seq in range(first, end + 1)))
        await writer.drain()
    stopped_at = time.monotonic()
    writer.write(STOP)
    await writer.drain()
    writer.close()
    await writer.wait_closed()
    if await publisher.wait() != 0:
        raise RuntimeError(f"Publisher exited with code {publisher.returncode}")
    return stopped_at


async def verify_subscription(reader, count):
    received = 0
    while True:
        line = await reader.readline()
        if line == READY and not received:
            continue
        if line == STOP and received == count:
            return time.monotonic()
        if received == count or line != payload(received + 1):
            raise RuntimeError(
                f"Expected sequence {received + 1} (or stop after {count}); "
                f"received {line[:24]!r} after {received} verified messages"
            )
        received += 1


async def run(rate, seconds):
    with tempfile.TemporaryDirectory(prefix="mini-mqtt-perf-") as workdir:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
            reservation.bind((HOST, 0))
            port = reservation.getsockname()[1]
        config = Path(workdir) / "mosquitto.conf"
        config.write_text(
            f"listener {port} {HOST}\nallow_anonymous true\npersistence false\nlog_type error\n",
            encoding="ascii",
        )
        env = {**os.environ, "XDG_CONFIG_HOME": workdir}
        mqtt_args = ("-h", HOST, "-p", str(port), "-V", "mqttv311", "-q", "0", "-t", TOPIC)

        async with AsyncExitStack() as processes:
            broker = await processes.enter_async_context(managed_process("mosquitto", "-c", str(config)))
            await wait_for_broker(broker, port)
            subscriber = await processes.enter_async_context(
                managed_process("mosquitto_sub", *mqtt_args, stdout=asyncio.subprocess.PIPE, env=env)
            )
            publisher = await processes.enter_async_context(
                managed_process("mosquitto_pub", *mqtt_args, "-l", stdin=asyncio.subprocess.PIPE, env=env)
            )
            await wait_for_subscription(publisher.stdin, subscriber.stdout)

            count = rate * seconds
            start = time.monotonic()
            async with asyncio.timeout(seconds + 10):
                async with asyncio.TaskGroup() as tasks:
                    sender = tasks.create_task(publish(publisher, rate, count, start))
                    receiver = tasks.create_task(verify_subscription(subscriber.stdout, count))

            # Recheck delivery after the stop marker has arrived and the publisher has exited.
            try:
                extra = await asyncio.wait_for(subscriber.stdout.readline(), QUIET_SECONDS)
            except TimeoutError:
                extra = None
            if extra is not None:
                raise RuntimeError(f"Subscriber terminated or received data after stop: {extra[:24]!r}")
            if broker.returncode is not None or subscriber.returncode is not None:
                raise RuntimeError("Broker or subscriber exited during the quiet period")

    elapsed = receiver.result() - start
    return {
        "boundary": "mosquitto-cli-round-trip",
        "scenario": "paced-stop",
        "mqtt_version": "3.1.1",
        "qos": 0,
        "target_per_second": rate,
        "target_duration_s": seconds,
        "payload_bytes": PAYLOAD_BYTES,
        "submitted": count,
        "verified": count,
        "offer_ms": round((sender.result() - start) * 1000, 2),
        "drain_ms": round((receiver.result() - sender.result()) * 1000, 2),
        "total_ms": round(elapsed * 1000, 2),
        "verified_per_second": round(count / elapsed),
        "quiet_ms": round(QUIET_SECONDS * 1000),
        "post_stop_messages": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rate", type=int, default=2000, help="target messages per second (default: 2000)")
    parser.add_argument("--seconds", type=int, default=2, help="target workload length (default: 2)")
    args = parser.parse_args()
    if not 1 <= args.rate <= 100_000 or not 1 <= args.seconds <= 300:
        parser.error("--rate must be 1–100000 and --seconds must be 1–300")
    missing = [name for name in ("mosquitto", "mosquitto_pub", "mosquitto_sub") if not shutil.which(name)]
    if missing:
        parser.error(f"missing commands on PATH: {', '.join(missing)}")
    try:
        print("PERF " + json.dumps(asyncio.run(run(args.rate, args.seconds))))
    except TimeoutError:
        print("Broker benchmark timed out waiting for startup, readiness, or delivery", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
