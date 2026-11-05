#!/bin/zsh
cd "$(dirname "$0")"
PORT=8765
echo "Đang khởi động ElevenLabs Studio App tại http://localhost:$PORT ..."
(sleep 1 && open "http://localhost:$PORT") &
/usr/bin/ruby server.rb
