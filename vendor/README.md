`libgomp.so.1`: GNU OpenMP runtime (x86-64 Linux), from Ubuntu 20.04 package `libgomp1_10.5.0-1ubuntu1~20.04_amd64.deb`
(GPL-3.0 with the GCC Runtime Library Exception). LightGBM needs it, and Vercel's Python runtime does not ship it,
so `app/server.py` preloads this copy on Linux when the system has none.
