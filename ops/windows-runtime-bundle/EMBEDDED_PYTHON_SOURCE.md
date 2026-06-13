# Embedded Python source

The Windows Agent v2 runtime bundle is seeded with the official
`python-3.12.6-embed-amd64.zip` distribution published by python.org.

```
URL    : https://www.python.org/ftp/python/3.12.6/python-3.12.6-embed-amd64.zip
SHA-256: 29DEFFFCC1A2B6F8AA67CB0C58F0FF0EA8DD2C8B7AF89A22B89BA45BCD5DA8F8
```

The same pair is committed to `release-pins.toml` as `EMBEDDED_PYTHON_URL`
and `EMBEDDED_PYTHON_SHA256`.

## Manual verification

Download once into a scratch directory and verify the SHA-256:

```
$ curl -L -o python-3.12.6-embed-amd64.zip \
    https://www.python.org/ftp/python/3.12.6/python-3.12.6-embed-amd64.zip
$ shasum -a 256 python-3.12.6-embed-amd64.zip
29DEFFFCC1A2B6F8AA67CB0C58F0FF0EA8DD2C8B7AF89A22B89BA45BCD5DA8F8  python-3.12.6-embed-amd64.zip
```

(`sha256sum` on Linux produces lowercase; `shasum -a 256` on macOS
produces lowercase too. The pin is stored uppercase for parity with
the on-disk `<bundle>.zip.sha256` sidecar convention; comparisons are
case-insensitive on the hex.)

The builder MUST refuse any other SHA-256. PR #4's CI runs the actual
download + verify path on `windows-2022`; PR #1 only ships the pin.
