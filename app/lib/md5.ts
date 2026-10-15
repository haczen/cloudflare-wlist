/**
 * 纯 JS MD5 实现（Workers Web Crypto 不支持 MD5，
 * 百度网盘分片上传需要 slice-md5）。
 */

function toUtf8Bytes(str: string): number[] {
	const bytes: number[] = [];
	for (let i = 0; i < str.length; i++) {
		let code = str.charCodeAt(i);
		if (code < 0x80) {
			bytes.push(code);
		} else if (code < 0x800) {
			bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
			// 代理对
			const low = str.charCodeAt(i + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
				bytes.push(
					0xf0 | (code >> 18),
					0x80 | ((code >> 12) & 0x3f),
					0x80 | ((code >> 6) & 0x3f),
					0x80 | (code & 0x3f)
				);
				i++;
			} else {
				bytes.push(0xef, 0xbf, 0xbd);
			}
		} else {
			bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		}
	}
	return bytes;
}

const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
	K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

function rotl(x: number, c: number): number {
	return (x << c) | (x >>> (32 - c));
}

function md5Core(bytes: Uint8Array): Uint8Array {
	// 填充
	const originalLength = bytes.length;
	const bitLength = originalLength * 8;
	const paddedLength = (((originalLength + 8) >>> 6) + 1) << 6;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[originalLength] = 0x80;
	// 长度按小端写入末尾 8 字节
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, bitLength >>> 0, true);
	view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	for (let chunk = 0; chunk < paddedLength; chunk += 32 * 4) {
		const M = new Uint32Array(16);
		for (let i = 0; i < 16; i++) {
			M[i] = view.getUint32(chunk + i * 4, true);
		}

		let A = a0, B = b0, C = c0, D = d0;

		for (let i = 0; i < 64; i++) {
			let F: number, g: number;
			if (i < 16) {
				F = (B & C) | (~B & D);
				g = i;
			} else if (i < 32) {
				F = (D & B) | (~D & C);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * i) % 16;
			}
			F = (F + A + K[i] + M[g]) >>> 0;
			A = D;
			D = C;
			C = B;
			B = (B + rotl(F, S[i])) >>> 0;
		}

		a0 = (a0 + A) >>> 0;
		b0 = (b0 + B) >>> 0;
		c0 = (c0 + C) >>> 0;
		d0 = (d0 + D) >>> 0;
	}

	const digest = new Uint8Array(16);
	const dv = new DataView(digest.buffer);
	dv.setUint32(0, a0, true);
	dv.setUint32(4, b0, true);
	dv.setUint32(8, c0, true);
	dv.setUint32(12, d0, true);
	return digest;
}

export function md5Hex(input: string | Uint8Array): string {
	const bytes =
		typeof input === "string" ? new Uint8Array(toUtf8Bytes(input)) : input;
	const digest = md5Core(bytes);
	return Array.from(digest)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
