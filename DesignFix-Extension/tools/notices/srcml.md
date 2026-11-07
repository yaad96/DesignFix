## 1. srcML Toolkit 0.9.5 and the libraries it loads (bin/srcml-win/)

`bin/srcml-win/bin/` contains the Windows build of the srcML Toolkit 0.9.5 (`srcml.exe`, `libsrcml.dll`) and the libraries it loads. DesignFix runs `srcml.exe` as a separate program to convert Java source files to srcML; it does not link against it.

| File | Component | Version | License |
| --- | --- | --- | --- |
| srcml.exe, libsrcml.dll | srcML Toolkit, Copyright (C) 2013-2014 srcML, LLC (www.srcML.org) | 0.9.5 | GNU GPL, version 2 or (at your option) any later version |
| boost_*-vc141-mt-1_65_1.dll | Boost C++ Libraries | 1.65.1 | Boost Software License 1.0 |
| libxml2.dll | libxml2 | not recorded in the binary | MIT |
| libxslt.dll, libexslt.dll | libxslt, libexslt | not recorded in the binary | libxslt license (MIT-style) |
| libcurl.dll | curl (libcurl), (C) 1996-2017 Daniel Stenberg | 7.55.1 | curl license (MIT-style) |
| libeay32.dll, ssleay32.dll | OpenSSL | 1.0.2l | OpenSSL License and original SSLeay License |
| libssh2.dll | libssh2 | 1.8.0 | BSD-3-Clause |
| archive.dll | libarchive | not recorded in the binary | BSD-style (see text) |
| lz4.dll | LZ4 library | not recorded in the binary | BSD-2-Clause |
| lzma.dll | liblzma (XZ Utils) | not recorded in the binary | Public domain |
| libbz2.dll | libbzip2 | not recorded in the binary | bzip2 license (BSD-style) |
| zlib1.dll | zlib, (C) 1995-2017 Jean-loup Gailly and Mark Adler | 1.2.11 | zlib license |
| libiconv.dll, libcharset.dll | GNU libiconv, libcharset | not recorded in the binary | GNU LGPL, version 2.1 or later |

Source code for the srcML Toolkit is available from the srcML project at https://www.srcml.org and https://github.com/srcML/srcML.

This product includes software developed by the OpenSSL Project for use in the OpenSSL Toolkit (http://www.openssl.org/). This product includes cryptographic software written by Eric Young (eay@cryptsoft.com). This product includes software written by Tim Hudson (tjh@cryptsoft.com).

The full license texts follow.
