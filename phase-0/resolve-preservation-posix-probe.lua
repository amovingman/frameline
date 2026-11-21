-- Private 294-byte sentinel calibration only. No project/DB/SQL operation.
-- Darwin SDK fcntl.h/unistd.h: O_RDONLY=0, O_NONBLOCK=4, O_NOFOLLOW=256;
-- LP64 ssize_t=long, size_t=unsigned long, off_t=long long.
local M = {}
local function expected_sentinel()
    local all = {}
    for byte = 0, 255 do all[#all + 1] = string.char(byte) end
    return 'FRAMELINE_BINARY_SENTINEL_V1' .. table.concat(all) .. string.char(0,13,10,13,10,0,255,10,13,0)
end
local function base(status, reason)
    return {status=status,reason=reason,readOnly=true,sourceDatabaseRead=false,projectOperationsPerformed=false,
        knownSentinelBytes=294,exactByteEquality=false,handleClosed=false,preparedPrivatePathVerificationRequired=true}
end
local function valid(path, expected)
    return type(path)=='string' and #path<=4096 and path:sub(1,1)=='/' and path:match('%.bin$')
        and not path:find('[%z\1-\31\127]') and expected==expected_sentinel() and #expected==294
end
local function standard_io(path, expected)
    if not valid(path,expected) then return base('failed','invalid-private-sentinel-input') end
    if type(io)~='table' or type(io.open)~='function' then return base('unsupported','standard-io-unavailable') end
    local opened, handle = pcall(function() return io.open(path,'rb') end)
    if not opened or not handle then return base('failed','standard-io-open-failed') end
    local report=base('failed','standard-io-read-failed')
    report.binaryMode='rb'
    report.noFollowGuaranteedByThisRoutine=false
    local ok=pcall(function()
        local size=handle:seek('end',0)
        assert(size==#expected,'sentinel-size')
        assert(handle:seek('set',0)==0,'sentinel-rewind')
        local value=handle:read(#expected)
        local position=handle:seek('cur',0)
        local eof=handle:read(1)
        local final=handle:seek('cur',0)
        report.bytesReturned=type(value)=='string' and #value or 0
        report.positionAfterRead=position
        report.positionAfterEof=final
        report.eofIsNil=eof==nil
        assert(type(value)=='string' and value==expected and position==#expected and eof==nil and final==#expected,'sentinel-bytes')
        assert(handle:seek('end',0)==#expected,'sentinel-size-changed')
        report.status='captured';report.reason='exact-known-sentinel';report.exactByteEquality=true
    end)
    local closed,value=pcall(function() return handle:close() end)
    report.handleClosed=closed and value~=false and value~=nil
    if not ok or not report.handleClosed then report.status='failed';report.exactByteEquality=false end
    return report
end
local cached_ffi=nil
local function ffi_library()
    local ffi=rawget(_G,'ffi')
    if type(ffi)~='table' then
        if type(require)~='function' then return nil,'require-unavailable' end
        local ok,loaded=pcall(require,'ffi')
        if not ok or type(loaded)~='table' then return nil,'ffi-unavailable' end
        ffi=loaded
    end
    local supported=false
    local abi_ok=pcall(function()
        supported=ffi.os=='OSX' and (ffi.arch=='x64' or ffi.arch=='arm64') and ffi.abi('64bit')
            and ffi.sizeof('void *')==8 and ffi.sizeof('long')==8 and ffi.sizeof('long long')==8
            and ffi.sizeof('unsigned long')==8 and ffi.sizeof('int')==4
    end)
    if not abi_ok or not supported then return nil,'unsupported-posix-abi' end
    if cached_ffi~=ffi then
        local declared=pcall(function() ffi.cdef[[
            int open(const char *path, int flags, ...);
            long read(int fd, void *buffer, unsigned long length);
            long long lseek(int fd, long long offset, int whence);
            int close(int fd);
        ]] end)
        if not declared then return nil,'ffi-declarations-unavailable' end
        cached_ffi=ffi
    end
    return ffi,nil
end
local function posix_ffi(path, expected)
    if not valid(path,expected) then return base('failed','invalid-private-sentinel-input') end
    local ffi,reason=ffi_library()
    if not ffi then return base('unsupported',reason) end
    local report=base('failed','posix-read-failed')
    report.ffiAbiValidated=true
    report.ownAllocatedBuffer=true
    report.noIoClassUserdataCast=true
    report.noFollowGuaranteedByThisRoutine=true
    report.allocationBytes=#expected
    report.openFlags=260 -- O_RDONLY | O_NOFOLLOW | O_NONBLOCK, Darwin LP64.
    local fd=-1
    local ok=pcall(function()
        fd=tonumber(ffi.C.open(path,260))
        assert(fd and fd>=0,'sentinel-open')
        local size=tonumber(ffi.C.lseek(fd,0,2))
        assert(size==#expected,'sentinel-size')
        assert(tonumber(ffi.C.lseek(fd,0,0))==0,'sentinel-rewind')
        local buffer=ffi.new('unsigned char[?]',#expected)
        local parts,total,calls={},0,0
        while total<#expected do
            local wanted=#expected-total
            local count=tonumber(ffi.C.read(fd,buffer,wanted))
            assert(count and count>0 and count%1==0 and count<=wanted,'sentinel-read-count')
            parts[#parts+1]=ffi.string(buffer,count) -- Only this owned allocation.
            total=total+count;calls=calls+1
            assert(calls<=#expected,'sentinel-read-bound')
        end
        local position=tonumber(ffi.C.lseek(fd,0,1))
        local eof=tonumber(ffi.C.read(fd,buffer,1))
        local final=tonumber(ffi.C.lseek(fd,0,1))
        report.bytesReturned=total;report.readCalls=calls;report.positionAfterRead=position
        report.eofCount=eof;report.positionAfterEof=final
        assert(total==#expected and table.concat(parts)==expected and position==#expected and eof==0 and final==#expected,'sentinel-bytes')
        assert(tonumber(ffi.C.lseek(fd,0,2))==#expected,'sentinel-size-changed')
        report.status='captured';report.reason='exact-known-sentinel';report.exactByteEquality=true
    end)
    if fd and fd>=0 then
        local closed,value=pcall(function() return tonumber(ffi.C.close(fd)) end)
        report.handleClosed=closed and value==0
    end
    if not ok or not report.handleClosed then report.status='failed';report.exactByteEquality=false end
    return report
end
function M.probe(path, expected)
    return {schemaVersion=1,operation='private-sentinel-standard-posix-read-calibration',readOnly=true,
        sourceDatabaseRead=false,projectOperationsPerformed=false,
        realm={ioType=type(io),ioOpenType=type(io)=='table' and type(io.open) or 'not-applicable',
            requireType=type(require),globalFfiType=type(rawget(_G,'ffi'))},
        standardIo=standard_io(path,expected),posixFfi=posix_ffi(path,expected)}
end
return M
