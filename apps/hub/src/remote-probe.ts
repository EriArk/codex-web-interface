import { createCipheriv } from "node:crypto";
import { createConnection } from "node:net";
import { tailnetAddressSchema } from "@codex-web/shared";

/** RFC 6143 VNC authentication only. Never sends ClientInit or asks for screen/input access. */
export function verifyPrivateVnc(host: string, password: string, connect = createConnection) {
  tailnetAddressSchema.parse(host);
  if (password.length !== 8 || !/^[A-Za-z0-9_-]{8}$/.test(password))
    throw Error("REMOTE_CREDENTIAL_INVALID");
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port: 5900 });
    let buffer: Buffer = Buffer.alloc(0),
      phase = 0,
      done = false;
    const end = (success = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (success) resolve();
      else reject(Error("REMOTE_VERIFICATION_FAILED"));
    };
    const timer = setTimeout(() => end(), 8000);
    socket.on("error", () => end());
    socket.on("close", () => end());
    socket.on("data", (chunk) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) {
        end();
        return;
      }
      try {
        for (;;) {
          if (phase === 0) {
            if (buffer.length < 12) return;
            if (buffer.subarray(0, 12).toString() !== "RFB 003.008\n") {
              end();
              return;
            }
            buffer = buffer.subarray(12);
            socket.write("RFB 003.008\n");
            phase = 1;
          } else if (phase === 1) {
            if (!buffer.length) return;
            const count = buffer[0]!;
            if (!count) {
              end();
              return;
            }
            if (buffer.length < count + 1) return;
            const types = buffer.subarray(1, count + 1);
            // An unauthenticated desktop must never be accepted as configured safely.
            if (!types.includes(2) || types.includes(1)) {
              end();
              return;
            }
            buffer = buffer.subarray(count + 1);
            socket.write(Buffer.from([2]));
            phase = 2;
          } else if (phase === 2) {
            if (buffer.length < 16) return;
            const key = Buffer.from(password, "ascii").map((byte) => {
              let reversed = 0;
              for (let bit = 0; bit < 8; bit++) reversed |= ((byte >> bit) & 1) << (7 - bit);
              return reversed;
            });
            // Repeating the same key in EDE3 equals DES, without OpenSSL's legacy provider.
            const cipher = createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
            cipher.setAutoPadding(false);
            const response = Buffer.concat([cipher.update(buffer.subarray(0, 16)), cipher.final()]);
            key.fill(0);
            buffer = buffer.subarray(16);
            socket.write(response);
            phase = 3;
          } else {
            if (buffer.length < 4) return;
            end(buffer.readUInt32BE(0) === 0);
            return;
          }
        }
      } catch {
        end();
      }
    });
  });
}
