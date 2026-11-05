#!/usr/bin/env ruby
# frozen_string_literal: true
# Backend cục bộ cho ElevenLabs Voice Studio (chỉ dùng thư viện có sẵn của macOS).
#  - Phục vụ giao diện web
#  - Đọc file kịch bản .xlsx
#  - Chọn thư mục (hộp thoại Finder)
#  - Lưu audio thành WAV (PCM thô -> WAV, MP3 -> WAV bằng afconvert)

require 'webrick'
require 'json'
require 'fileutils'
require 'base64'
require 'open3'
require 'tmpdir'

PORT = (ENV['PORT'] || 8765).to_i
ROOT_DIR = File.expand_path(__dir__)
DEFAULT_OUTPUT_DIR = File.join(ROOT_DIR, 'output_wav')
FileUtils.mkdir_p(DEFAULT_OUTPUT_DIR)

server = WEBrick::HTTPServer.new(
  Port: PORT,
  BindAddress: '127.0.0.1',
  DocumentRoot: File.join(ROOT_DIR, 'docs'),
  AccessLog: [],
  Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN)
)

def json_response(res, status, payload)
  res.status = status
  res['Content-Type'] = 'application/json; charset=utf-8'
  res.body = JSON.generate(payload)
end

def safe_name(str)
  str.to_s.gsub(%r{[/\\:*?"<>|\x00-\x1f]}, '_').strip
end

def route(server, path)
  server.mount_proc(path) do |req, res|
    begin
      body = req.body.to_s.empty? ? {} : JSON.parse(req.body)
      yield(body, res)
    rescue StandardError => e
      json_response(res, 500, { ok: false, error: "#{e.class}: #{e.message}" })
    end
  end
end

# ---------- Đọc xlsx ----------
def unescape_xml(s)
  s.gsub(/&#x([0-9a-fA-F]+);/) { [Regexp.last_match(1).hex].pack('U') }
   .gsub(/&#(\d+);/) { [Regexp.last_match(1).to_i].pack('U') }
   .gsub('&lt;', '<').gsub('&gt;', '>').gsub('&quot;', '"').gsub('&apos;', "'").gsub('&amp;', '&')
end

def col_index(letters)
  letters.upcase.each_char.reduce(0) { |a, ch| a * 26 + (ch.ord - 64) } - 1
end

def unzip_entry(file, entry)
  out, _err, st = Open3.capture3('/usr/bin/unzip', '-p', file, entry)
  return nil unless st.success?
  out.force_encoding('UTF-8')
end

def text_of(xml)
  xml.scan(%r{<(?:\w+:)?t\b[^>]*>(.*?)</(?:\w+:)?t>}m).flatten.map { |t| unescape_xml(t) }.join
end

def parse_xlsx(bytes)
  Dir.mktmpdir('xlsx_') do |dir|
    file = File.join(dir, 'in.xlsx')
    File.binwrite(file, bytes)

    shared = []
    ss = unzip_entry(file, 'xl/sharedStrings.xml')
    if ss
      ss.scan(%r{<(?:\w+:)?si\b[^>]*>(.*?)</(?:\w+:)?si>}m) { |m| shared << text_of(m[0]) }
    end

    wb = unzip_entry(file, 'xl/workbook.xml') or raise 'File không phải xlsx hợp lệ'
    rels = unzip_entry(file, 'xl/_rels/workbook.xml.rels').to_s
    rel_map = {}
    rels.scan(/<Relationship\b[^>]*>/) do |tag|
      id = tag[/\bId="([^"]*)"/, 1]
      target = tag[/\bTarget="([^"]*)"/, 1]
      rel_map[id] = target if id && target
    end

    sheets = []
    wb.scan(/<(?:\w+:)?sheet\b[^>]*>/).each_with_index do |tag, i|
      name = unescape_xml(tag[/\bname="([^"]*)"/, 1].to_s)
      rid = tag[/\br:id="([^"]*)"/, 1]
      target = rel_map[rid] || "worksheets/sheet#{i + 1}.xml"
      target = target.sub(%r{^/}, '')
      target = "xl/#{target}" unless target.start_with?('xl/')
      xml = unzip_entry(file, target)
      next unless xml

      grid = {}
      xml.scan(%r{<(?:\w+:)?c\b([^>]*?)(?:/>|>(.*?)</(?:\w+:)?c>)}m) do |attrs, inner|
        ref = attrs[/\br="([A-Z]+)(\d+)"/]
        next unless ref
        letters, rownum = attrs.match(/\br="([A-Z]+)(\d+)"/).captures
        type = attrs[/\bt="([^"]*)"/, 1]
        inner = inner.to_s
        val =
          case type
          when 's' then shared[inner[%r{<(?:\w+:)?v>(.*?)</(?:\w+:)?v>}m, 1].to_i].to_s
          when 'inlineStr' then text_of(inner)
          else unescape_xml(inner[%r{<(?:\w+:)?v>(.*?)</(?:\w+:)?v>}m, 1].to_s)
          end
        next if val.empty?
        (grid[rownum.to_i - 1] ||= {})[col_index(letters)] = val
      end

      max_row = grid.keys.max || -1
      rows = (0..max_row).map do |r|
        cells = grid[r] || {}
        width = (cells.keys.max || -1) + 1
        Array.new(width) { |c| cells[c].to_s }
      end
      sheets << { name: name, rows: rows }
    end
    sheets
  end
end

# ---------- Ghi WAV ----------
def pcm_to_wav(pcm, rate, bits = 16, channels = 1)
  byte_rate = rate * channels * bits / 8
  header = ['RIFF', 36 + pcm.bytesize, 'WAVE', 'fmt ', 16, 1, channels, rate, byte_rate,
            channels * bits / 8, bits, 'data', pcm.bytesize].pack('a4Va4a4VvvVVvva4V')
  header + pcm
end

# ---------- API ----------
route(server, '/api/status') do |_b, res|
  json_response(res, 200, { ok: true, default_output_dir: DEFAULT_OUTPUT_DIR })
end

route(server, '/api/pick-folder') do |_b, res|
  script = 'POSIX path of (choose folder with prompt "Chọn thư mục xuất file WAV:")'
  out, err, st = Open3.capture3('/usr/bin/osascript', '-e', script)
  if st.success?
    json_response(res, 200, { ok: true, folder: out.strip.sub(%r{/$}, '') })
  else
    json_response(res, 200, { ok: false, cancelled: true, message: err.strip })
  end
end

route(server, '/api/open-folder') do |b, res|
  folder = b['folder'].to_s.strip
  folder = DEFAULT_OUTPUT_DIR if folder.empty?
  FileUtils.mkdir_p(folder)
  system('/usr/bin/open', folder)
  json_response(res, 200, { ok: true })
end

route(server, '/api/parse-xlsx') do |b, res|
  sheets = parse_xlsx(Base64.decode64(b['data'].to_s))
  json_response(res, 200, { ok: true, sheets: sheets })
end

route(server, '/api/exists') do |b, res|
  folder = b['folder'].to_s.strip
  folder = DEFAULT_OUTPUT_DIR if folder.empty?
  sub = safe_name(b['subfolder'])
  dir = sub.empty? ? folder : File.join(folder, sub)
  path = File.join(dir, safe_name(b['filename']))
  json_response(res, 200, { ok: true, exists: File.exist?(path) })
end

route(server, '/api/save-wav') do |b, res|
  folder = b['folder'].to_s.strip
  folder = DEFAULT_OUTPUT_DIR if folder.empty?
  sub = safe_name(b['subfolder'])
  dir = sub.empty? ? folder : File.join(folder, sub)
  FileUtils.mkdir_p(dir)

  filename = safe_name(b['filename'])
  filename = "voice_#{Time.now.to_i}" if filename.empty?
  filename += '.wav' unless filename.downcase.end_with?('.wav')
  target = File.join(dir, filename)

  raw = Base64.decode64(b['audio_base64'].to_s)
  fmt = b['source_format'].to_s # pcm_44100, pcm_24000..., wav, mp3

  if fmt.start_with?('pcm_')
    rate = fmt.split('_')[1].to_i
    File.binwrite(target, pcm_to_wav(raw, rate))
  elsif fmt.start_with?('wav') || (raw[0, 4] == 'RIFF' && raw[8, 4] == 'WAVE')
    File.binwrite(target, raw)
  else
    Dir.mktmpdir('eleven_') do |tmp|
      input = File.join(tmp, 'in.mp3')
      File.binwrite(input, raw)
      rate = (b['sample_rate'] || 44100).to_i
      _o, err, st = Open3.capture3('/usr/bin/afconvert', '-f', 'WAVE', '-d', "LEI16@#{rate}", input, target)
      raise "afconvert lỗi: #{err}" unless st.success?
    end
  end

  json_response(res, 200, { ok: true, path: target, size: File.size(target) })
end

# ---------- Proxy tới ElevenLabs (tránh CORS) ----------
require 'net/http'
require 'uri'

server.mount_proc('/eleven') do |req, res|
  begin
    path = req.path.sub(%r{^/eleven}, '')
    uri = URI("https://api.elevenlabs.io#{path}#{req.query_string ? "?#{req.query_string}" : ''}")
    klass = { 'GET' => Net::HTTP::Get, 'POST' => Net::HTTP::Post,
              'DELETE' => Net::HTTP::Delete, 'PATCH' => Net::HTTP::Patch }[req.request_method]
    raise "Method không hỗ trợ: #{req.request_method}" unless klass

    up = klass.new(uri)
    up['xi-api-key'] = req['xi-api-key'].to_s
    up['Content-Type'] = req['content-type'] if req['content-type']
    up['Accept'] = req['accept'] || '*/*'
    up.body = req.body if req.body && !%w[GET DELETE].include?(req.request_method)

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = 30
    http.read_timeout = 300
    r = http.request(up)
    res.status = r.code.to_i
    res['Content-Type'] = r['content-type'] if r['content-type']
    res.body = r.body.to_s
  rescue StandardError => e
    json_response(res, 502, { detail: { message: "Proxy lỗi: #{e.class}: #{e.message}" } })
  end
end

trap('INT') { server.shutdown }
trap('TERM') { server.shutdown }

puts '===================================================='
puts ' ElevenLabs Voice Studio'
puts " Mở trình duyệt: http://localhost:#{PORT}"
puts " Thư mục WAV mặc định: #{DEFAULT_OUTPUT_DIR}"
puts '===================================================='
server.start
